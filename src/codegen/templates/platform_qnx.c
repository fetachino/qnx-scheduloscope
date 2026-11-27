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

#if SS_MAX_PRIORITY > SS_PRIVILEGED_CEILING
    /*
     * Priorities and PCP ceilings above the unprivileged ceiling (procnto -P,
     * 63 by default) need PROCMGR_AID_PRIORITY. Ask for it for ourselves. If we
     * cannot get it, thread/mutex setup below fails loudly and no measurement is
     * written; silently using a lower priority would describe another system.
     */
    if (procmgr_ability(0,
                        PROCMGR_ADN_NONROOT | PROCMGR_AOP_ALLOW | PROCMGR_AID_PRIORITY,
                        PROCMGR_AID_EOL) != 0) {
        fprintf(stderr,
                "[scheduloscope] cannot request PROCMGR_AID_PRIORITY for priority/ceiling %d "
                "above the unprivileged ceiling %d (%s); run as root or grant "
                "PROCMGR_AID_PRIORITY to the harness\n",
                (int)SS_MAX_PRIORITY, (int)SS_PRIVILEGED_CEILING, strerror(errno));
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
    t->handle = thread;
    t->started = 1;
    return 0;
}

int ss_thread_join(ss_thread *t) {
    if (!t || !t->started) return -1;
    int rc = pthread_join(t->handle, NULL);
    if (rc == 0) t->started = 0;
    return rc == 0 ? 0 : -1;
}

int ss_thread_join_timeout(ss_thread *t, uint64_t timeout_ms) {
    if (!t || !t->started) return -1;
#ifdef SS_FORCE_JOIN_FAILURE
    return -1;
#endif
    struct timespec deadline;
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) return -1;
    deadline.tv_sec += (time_t)(timeout_ms / 1000ull);
    deadline.tv_nsec += (long)((timeout_ms % 1000ull) * 1000000ull);
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }
    int rc = pthread_timedjoin(t->handle, NULL, &deadline);
    if (rc == 0) {
        t->started = 0;
        return 0;
    }
    return rc == ETIMEDOUT ? SS_JOIN_TIMEOUT : -1;
}

/* ---- start gate ------------------------------------------------------ */

typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int waiters;
    int arrived;
    int released;
} gate_impl;

int ss_gate_init(ss_gate *g, int waiters) {
    if (!g || waiters < 0) return -1;
    gate_impl *impl = (gate_impl *)calloc(1, sizeof(*impl));
    if (!impl) return -1;
    int rc = pthread_mutex_init(&impl->mu, NULL);
    if (rc != 0) {
        free(impl);
        return -1;
    }
    rc = pthread_cond_init(&impl->cv, NULL);
    if (rc != 0) {
        pthread_mutex_destroy(&impl->mu);
        free(impl);
        return -1;
    }
    impl->waiters = waiters;
    g->impl = impl;
    return 0;
}

int ss_gate_arrive(ss_gate *g) {
    gate_impl *impl = g ? (gate_impl *)g->impl : NULL;
    if (!impl) return -1;
    if (pthread_mutex_lock(&impl->mu) != 0) return -1;
    impl->arrived++;
    pthread_cond_broadcast(&impl->cv);
    while (!impl->released) {
        if (pthread_cond_wait(&impl->cv, &impl->mu) != 0) {
            pthread_mutex_unlock(&impl->mu);
            return -1;
        }
    }
    pthread_mutex_unlock(&impl->mu);
    return 0;
}

int ss_gate_wait_ready(ss_gate *g, uint64_t timeout_ms) {
    gate_impl *impl = g ? (gate_impl *)g->impl : NULL;
    if (!impl) return -1;
    struct timespec deadline;
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) return -1;
    deadline.tv_sec += (time_t)(timeout_ms / 1000ull);
    deadline.tv_nsec += (long)((timeout_ms % 1000ull) * 1000000ull);
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }
    if (pthread_mutex_lock(&impl->mu) != 0) return -1;
    int result = 0;
    while (impl->arrived < impl->waiters && !impl->released) {
        int rc = pthread_cond_timedwait(&impl->cv, &impl->mu, &deadline);
        if (rc == ETIMEDOUT) {
            result = SS_JOIN_TIMEOUT;
            break;
        }
        if (rc != 0) {
            result = -1;
            break;
        }
    }
    if (impl->released && impl->arrived < impl->waiters) result = -1;
    pthread_mutex_unlock(&impl->mu);
    return result;
}

int ss_gate_release(ss_gate *g) {
    gate_impl *impl = g ? (gate_impl *)g->impl : NULL;
    if (!impl) return -1;
    if (pthread_mutex_lock(&impl->mu) != 0) return -1;
    impl->released = 1;
    pthread_cond_broadcast(&impl->cv);
    pthread_mutex_unlock(&impl->mu);
    return 0;
}

void ss_gate_destroy(ss_gate *g) {
    gate_impl *impl = g ? (gate_impl *)g->impl : NULL;
    if (!impl) return;
    pthread_cond_destroy(&impl->cv);
    pthread_mutex_destroy(&impl->mu);
    free(impl);
    g->impl = NULL;
}

int ss_mutex_init(ss_mutex *m, int protocol, int ceiling) {
    pthread_mutexattr_t attr;
    int rc = pthread_mutexattr_init(&attr);
    if (rc != 0) {
        fprintf(stderr, "[scheduloscope] pthread_mutexattr_init failed: %s\n", strerror(rc));
        return -1;
    }
    if (protocol == SS_PROTO_INHERIT) {
        rc = pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_INHERIT);
    } else if (protocol == SS_PROTO_PROTECT) {
        rc = pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_PROTECT);
        if (rc == 0) rc = pthread_mutexattr_setprioceiling(&attr, ceiling);
    } else {
        /* QNX defaults a mutex to PTHREAD_PRIO_INHERIT; "none" must be explicit. */
        rc = pthread_mutexattr_setprotocol(&attr, PTHREAD_PRIO_NONE);
    }
    if (rc != 0) {
        fprintf(stderr,
                "[scheduloscope] cannot configure mutex protocol %d ceiling %d: %s; "
                "PTHREAD_PRIO_PROTECT and ceilings above the unprivileged limit need "
                "PROCMGR_AID_PRIORITY (run as root or grant it with procmgr_ability)\n",
                protocol, ceiling, strerror(rc));
        pthread_mutexattr_destroy(&attr);
        return -1;
    }
    pthread_mutex_t *mutex = (pthread_mutex_t *)malloc(sizeof(*mutex));
    if (!mutex) {
        pthread_mutexattr_destroy(&attr);
        return -1;
    }
    rc = pthread_mutex_init(mutex, &attr);
    pthread_mutexattr_destroy(&attr);
    if (rc != 0) {
        fprintf(stderr,
                "[scheduloscope] pthread_mutex_init(protocol %d, ceiling %d) failed: %s; "
                "check PROCMGR_AID_PRIORITY if the ceiling is above the unprivileged limit\n",
                protocol, ceiling, strerror(rc));
        free(mutex);
        return -1;
    }
    if (protocol == SS_PROTO_PROTECT) {
        int actual = -1;
        rc = pthread_mutex_getprioceiling(mutex, &actual);
        if (rc != 0 || actual != ceiling) {
            fprintf(stderr,
                    "[scheduloscope] mutex ceiling was not applied: requested %d, got %d (%s)\n",
                    ceiling, actual, rc == 0 ? "value differs" : strerror(rc));
            pthread_mutex_destroy(mutex);
            free(mutex);
            return -1;
        }
    }
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

int ss_channel_recv(ss_channel *c, void *buf, size_t len, ss_client_id *client) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    struct _msg_info info;
    memset(&info, 0, sizeof(info));
    rcvid_t rcvid = MsgReceive(impl->chid, buf, len, &info);
    if (rcvid == -1) return -1;
    if (rcvid == 0) {
        if (len < sizeof(struct _pulse)) return -1;
        struct _pulse pulse;
        memcpy(&pulse, buf, sizeof(pulse));
        /* A stop is not a request: no handler, no reply. */
        return pulse.code == SS_STOP_PULSE_CODE ? 1 : -1;
    }
    *client = (ss_client_id)rcvid;
    return 0;
}

int ss_channel_reply(ss_channel *c, ss_client_id client, const void *buf, size_t len) {
    (void)c;
    return MsgReply((rcvid_t)client, 0, buf, len) == 0 ? 0 : -1;
}

int ss_channel_send(ss_channel *c, const void *buf, size_t len) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    /* The server replies, so give the kernel a reply buffer to write into. */
    char reply[64];
    return MsgSend(impl->coid, buf, len, reply, sizeof(reply)) == 0 ? 0 : -1;
}
int ss_channel_send_stop(ss_channel *c) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
#ifdef SS_FORCE_STOP_FAILURE
    return -1;
#endif
    /* Non-blocking pulse; -1 inherits the sender's priority. */
    return MsgSendPulse(impl->coid, -1, SS_STOP_PULSE_CODE, 0) == 0 ? 0 : -1;
}