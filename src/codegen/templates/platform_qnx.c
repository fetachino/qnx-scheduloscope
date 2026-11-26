/*
 * QNX OS 8.0 backend.
 *
 * Everything QNX-specific in the harness lives here:
 *
 *   - SCHED_FIFO / SCHED_RR / SCHED_SPORADIC with explicit scheduling
 *     parameters (pthread_attr_setinheritsched + sched_param, including the
 *     sched_ss_* sporadic fields);
 *   - PTHREAD_PRIO_INHERIT / PTHREAD_PRIO_PROTECT mutexes through
 *     pthread_mutexattr_setprotocol();
 *   - real channels: ChannelCreate(), MsgReceive(), MsgReply(), MsgSend() and
 *     the _NTO_CHF_FIXED_PRIORITY flag;
 *   - microseconds from ClockCycles() and the system page's cycles_per_sec.
 *
 * Build with the QNX SDP 8.0 toolchain:
 *   source ~/qnx800/qnxsdp-env.sh
 *   qcc -V gcc_ntox86_64 -O2 -Wall -o scheduloscope-harness harness.c platform_qnx.c
 */
#include "platform.h"
#include "workload_config.h"

#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/neutrino.h>
#include <sys/procmgr.h>
#include <sys/syspage.h>
#include <time.h>
#include <unistd.h>

static uint64_t g_cycles_per_us;
static uint64_t g_epoch_cycles;
static int g_scheduling_enforced = 1;

int ss_scheduling_enforced(void) { return g_scheduling_enforced; }

int ss_init(void) {
    g_cycles_per_us = (uint64_t)SYSPAGE_ENTRY(qtime)->cycles_per_sec / 1000000ull;
    if (g_cycles_per_us == 0) g_cycles_per_us = 1;
    g_epoch_cycles = ClockCycles();

#if SS_MAX_PRIORITY > 63
    /*
     * Priorities above the unprivileged ceiling (procnto -P, 63 by default)
     * need PROCMGR_AID_PRIORITY. Ask for it for ourselves; if the process is
     * not allowed to, keep going and say so, because the measurement is still
     * useful at the clamped priority. Running as root grants it implicitly.
     */
    if (procmgr_ability(0,
                        PROCMGR_ADN_NONROOT | PROCMGR_AOP_ALLOW | PROCMGR_AID_PRIORITY,
                        PROCMGR_AID_EOL) != 0) {
        fprintf(stderr,
                "[scheduloscope] cannot enable priorities above 63 (%s); run as root or "
                "start the harness with 'on -P %d'\n",
                strerror(errno), (int)SS_MAX_PRIORITY);
    }
#endif
    return 0;
}

void ss_shutdown(void) {}

uint64_t ss_now_us(void) { return (ClockCycles() - g_epoch_cycles) / g_cycles_per_us; }

void ss_spin_us(uint64_t us) {
    uint64_t target = ClockCycles() + us * g_cycles_per_us;
    volatile uint64_t sink = 1;
    while (ClockCycles() < target) {
        sink = sink * 1664525ull + 1013904223ull;
    }
    (void)sink;
}

void ss_sleep_us(uint64_t us) {
    struct timespec req;
    req.tv_sec = (time_t)(us / 1000000ull);
    req.tv_nsec = (long)((us % 1000000ull) * 1000ull);
    while (nanosleep(&req, &req) == -1 && errno == EINTR) {
    }
}

typedef struct {
    void (*entry)(void *);
    void *arg;
} start_args;

static void *trampoline(void *raw) {
    start_args args = *(start_args *)raw;
    free(raw);
    args.entry(args.arg);
    return NULL;
}

int ss_thread_start(ss_thread *t, const char *name, int priority, int policy,
                    int sporadic_low_priority, uint64_t sporadic_budget_us,
                    uint64_t sporadic_replenish_us, int sporadic_max_repl, void (*entry)(void *), void *arg) {
    start_args *args = (start_args *)malloc(sizeof(*args));
    if (!args) return -1;
    args->entry = entry;
    args->arg = arg;

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setstacksize(&attr, 256 * 1024);

    struct sched_param param;
    memset(&param, 0, sizeof(param));
    param.sched_priority = priority;

    int sched_policy = SCHED_FIFO;
    if (policy == SS_POLICY_RR) {
        sched_policy = SCHED_RR;
    } else if (policy == SS_POLICY_SPORADIC) {
        sched_policy = SCHED_SPORADIC;
        param.sched_ss_low_priority = sporadic_low_priority;
        param.sched_ss_init_budget.tv_sec = (time_t)(sporadic_budget_us / 1000000ull);
        param.sched_ss_init_budget.tv_nsec = (long)((sporadic_budget_us % 1000000ull) * 1000ull);
        param.sched_ss_repl_period.tv_sec = (time_t)(sporadic_replenish_us / 1000000ull);
        param.sched_ss_repl_period.tv_nsec = (long)((sporadic_replenish_us % 1000000ull) * 1000ull);
        param.sched_ss_max_repl = sporadic_max_repl > 0 ? sporadic_max_repl : 1;
    }

    int policy_rc = pthread_attr_setschedpolicy(&attr, sched_policy);
    if (policy_rc != 0) {
        fprintf(stderr,
                "[scheduloscope] cannot set policy %d for %s (priority %d): %s; "
                "the workload would not run as modelled\n",
                (int)sched_policy, name ? name : "thread", priority, strerror(policy_rc));
        pthread_attr_destroy(&attr);
        free(args);
        return -1;
    }

    int param_rc = pthread_attr_setschedparam(&attr, &param);
    if (param_rc != 0) {
        fprintf(stderr,
                "[scheduloscope] cannot set priority %d for %s: %s; the workload would not run as "
                "modelled (a priority above the process limit needs PROCMGR_AID_PRIORITY or root)\n",
                priority, name ? name : "thread", strerror(param_rc));
        pthread_attr_destroy(&attr);
        free(args);
        return -1;
    }

    pthread_t thread;
    int rc = pthread_create(&thread, &attr, trampoline, args);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        free(args);
        fprintf(stderr, "[scheduloscope] pthread_create(%s) failed: %s\n", name ? name : "thread", strerror(rc));
        return -1;
    }
    if (name) pthread_setname_np(thread, name);
    t->handle = (unsigned long)thread;
    t->started = 1;
    return 0;
}

int ss_thread_join(ss_thread *t) {
    if (!t->started) return -1;
    return pthread_join((pthread_t)t->handle, NULL) == 0 ? 0 : -1;
}

int ss_mutex_init(ss_mutex *m, int protocol, int ceiling) {
    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    if (protocol == SS_PROTO_INHERIT) {
        pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
    } else if (protocol == SS_PROTO_PROTECT) {
        pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_PROTECT);
        pthread_mutexattr_setprioceiling(&attr, ceiling);
    }
    pthread_mutex_t *mutex = (pthread_mutex_t *)malloc(sizeof(*mutex));
    if (!mutex) return -1;
    if (pthread_mutex_init(mutex, &attr) != 0) {
        pthread_mutexattr_destroy(&attr);
        free(mutex);
        return -1;
    }
    pthread_mutexattr_destroy(&attr);
    m->impl = mutex;
    return 0;
}

void ss_mutex_destroy(ss_mutex *m) {
    pthread_mutex_t *mutex = (pthread_mutex_t *)m->impl;
    if (!mutex) return;
    pthread_mutex_destroy(mutex);
    free(mutex);
    m->impl = NULL;
}

int ss_mutex_lock(ss_mutex *m) {
    pthread_mutex_t *mutex = (pthread_mutex_t *)m->impl;
    return mutex && pthread_mutex_lock(mutex) == 0 ? 0 : -1;
}

int ss_mutex_unlock(ss_mutex *m) {
    pthread_mutex_t *mutex = (pthread_mutex_t *)m->impl;
    return mutex && pthread_mutex_unlock(mutex) == 0 ? 0 : -1;
}

/* ---- message passing ------------------------------------------------ */

typedef struct {
    int chid;
    int coid;
    int fixed_priority;
} channel_impl;

int ss_channel_create(ss_channel *c, int fixed_priority) {
    channel_impl *impl = (channel_impl *)calloc(1, sizeof(*impl));
    if (!impl) return -1;
    int flags = fixed_priority ? _NTO_CHF_FIXED_PRIORITY : 0;
    impl->chid = ChannelCreate(flags);
    if (impl->chid < 0) {
        free(impl);
        return -1;
    }
    /* Same process: connect to our own channel for MsgSend(). */
    impl->coid = ConnectAttach(0, 0, impl->chid, _NTO_SIDE_CHANNEL, 0);
    if (impl->coid < 0) {
        ChannelDestroy(impl->chid);
        free(impl);
        return -1;
    }
    impl->fixed_priority = fixed_priority;
    c->impl = impl;
    return 0;
}

void ss_channel_destroy(ss_channel *c) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return;
    ConnectDetach(impl->coid);
    ChannelDestroy(impl->chid);
    free(impl);
    c->impl = NULL;
}

int ss_channel_recv(ss_channel *c, void *buf, size_t len, int *client) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    struct _msg_info info;
    memset(&info, 0, sizeof(info));
    int rcvid = MsgReceive(impl->chid, buf, len, &info);
    if (rcvid == -1) return -1;
    *client = rcvid;
    return 0;
}

int ss_channel_reply(ss_channel *c, int client, const void *buf, size_t len) {
    (void)c;
    return MsgReply(client, 0, buf, len) == 0 ? 0 : -1;
}

int ss_channel_send(ss_channel *c, const void *buf, size_t len) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    /* The server replies, so give the kernel a reply buffer to write into. */
    char reply[64];
    return MsgSend(impl->coid, buf, len, reply, sizeof(reply)) == 0 ? 0 : -1;
}
