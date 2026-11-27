/*
 * POSIX host backend.
 *
 * This backend exists so the generated workload can be compiled, run and
 * debugged on a normal Linux machine. It reproduces the *shape* of the QNX
 * system (thread priorities, mutex protocols, message passing) but it is not a
 * real-time scheduler and it makes no attempt to emulate QNX scheduling
 * decisions. Use it to validate the harness, never to publish latency numbers
 * as if they came from QNX.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "platform.h"

#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t g_epoch;
static int g_scheduling_enforced = 1;

int ss_scheduling_enforced(void) { return g_scheduling_enforced; }

static uint64_t raw_now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)ts.tv_nsec / 1000ull;
}

int ss_init(void) {
    g_epoch = raw_now_us();
    return 0;
}

void ss_shutdown(void) {}

uint64_t ss_now_us(void) { return raw_now_us() - g_epoch; }

void ss_spin_us(uint64_t us) {
    uint64_t target = raw_now_us() + us;
    volatile uint64_t sink = 1;
    while (raw_now_us() < target) {
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
    (void)sporadic_low_priority;
    (void)sporadic_budget_us;
    (void)sporadic_replenish_us;
    (void)sporadic_max_repl;

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
    if (policy == SS_POLICY_RR) sched_policy = SCHED_RR;

#ifdef SS_FORCE_SCHED_FAILURE
    /* Test hook: exercises the hard-failure path without a QNX target. */
    fprintf(stderr, "[scheduloscope] injected scheduling failure for %s\n", name ? name : "thread");
    pthread_attr_destroy(&attr);
    free(args);
    return -1;
#endif

    int policy_rc = pthread_attr_setschedpolicy(&attr, sched_policy);
    int param_rc = pthread_attr_setschedparam(&attr, &param);
#ifdef SS_FORCE_SCHED_FALLBACK
    /* Test hook: exercises the documented best-effort fallback. */
    policy_rc = EINVAL;
#endif
    if (policy_rc != 0 || param_rc != 0) {
        fprintf(stderr,
                "[scheduloscope] host cannot enforce policy %d at priority %d for %s (%s); continuing "
                "best-effort, so the report will not describe the modelled system\n",
                sched_policy, priority, name ? name : "thread",
                strerror(policy_rc != 0 ? policy_rc : param_rc));
        g_scheduling_enforced = 0;
        pthread_attr_destroy(&attr);
        pthread_attr_init(&attr);
        pthread_attr_setstacksize(&attr, 256 * 1024);
    }

    pthread_t thread;
    int rc = pthread_create(&thread, &attr, trampoline, args);
    if (rc != 0) {
        /* Unprivileged hosts reject real-time priorities; fall back so the
         * harness still runs, and mark the run best-effort. */
        fprintf(stderr, "[scheduloscope] cannot set real-time priorities (%s); running with default policy\n", strerror(rc));
        g_scheduling_enforced = 0;
        pthread_attr_destroy(&attr);
        pthread_attr_init(&attr);
        rc = pthread_create(&thread, &attr, trampoline, args);
    }
    pthread_attr_destroy(&attr);
    if (rc != 0) {
        free(args);
        return -1;
    }
    if (name) {
        /* 15 characters is the portable thread-name limit. */
        char trimmed[16];
        snprintf(trimmed, sizeof(trimmed), "%s", name);
        pthread_setname_np(thread, trimmed);
    }
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
    int rc = pthread_timedjoin_np(t->handle, NULL, &deadline);
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
    int rc = pthread_mutex_lock(&impl->mu);
    if (rc != 0) return -1;
    impl->arrived++;
    pthread_cond_broadcast(&impl->cv);
    while (!impl->released) {
        rc = pthread_cond_wait(&impl->cv, &impl->mu);
        if (rc != 0) {
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
    }
    if (rc != 0) {
        /* The host may lack CAP_SYS_NICE. Say so, mark the run best-effort,
         * and rebuild the attribute without the unsupported protocol rather
         * than running with an unnoticed different mutex. */
        fprintf(stderr,
                "[scheduloscope] host cannot configure mutex protocol %d ceiling %d (%s); "
                "continuing best-effort without that protocol\n",
                protocol, ceiling, strerror(rc));
        g_scheduling_enforced = 0;
        pthread_mutexattr_destroy(&attr);
        rc = pthread_mutexattr_init(&attr);
        if (rc != 0) {
            fprintf(stderr, "[scheduloscope] pthread_mutexattr_init(retry) failed: %s\n", strerror(rc));
            return -1;
        }
    }
    pthread_mutex_t *mutex = (pthread_mutex_t *)malloc(sizeof(*mutex));
    if (!mutex) {
        pthread_mutexattr_destroy(&attr);
        return -1;
    }
    rc = pthread_mutex_init(mutex, &attr);
    pthread_mutexattr_destroy(&attr);
    if (rc != 0) {
        fprintf(stderr, "[scheduloscope] pthread_mutex_init failed: %s\n", strerror(rc));
        free(mutex);
        return -1;
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

#define SS_MAX_PENDING 64

typedef struct {
    int state; /* 0 free, 1 queued, 2 replied */
    pthread_cond_t cv;
} reply_slot;

typedef struct {
    pthread_mutex_t mu;
    pthread_cond_t available;
    int fixed_priority;
    int head;
    int tail;
    int count;
    int stop_pending;
    int queue[SS_MAX_PENDING];
    reply_slot slots[SS_MAX_PENDING];
} channel_impl;

int ss_channel_create(ss_channel *c, int fixed_priority) {
#ifdef SS_FORCE_CHANNEL_FAILURE
    /* Test hook: exercises partial-initialization cleanup. */
    (void)c;
    (void)fixed_priority;
    return -1;
#endif
    channel_impl *impl = (channel_impl *)calloc(1, sizeof(*impl));
    if (!impl) return -1;
    int rc = pthread_mutex_init(&impl->mu, NULL);
    if (rc != 0) {
        fprintf(stderr, "[scheduloscope] channel mutex init failed: %s\n", strerror(rc));
        free(impl);
        return -1;
    }
    rc = pthread_cond_init(&impl->available, NULL);
    if (rc != 0) {
        fprintf(stderr, "[scheduloscope] channel condition init failed: %s\n", strerror(rc));
        pthread_mutex_destroy(&impl->mu);
        free(impl);
        return -1;
    }
    int initialized = 0;
    for (; initialized < SS_MAX_PENDING; initialized++) {
        rc = pthread_cond_init(&impl->slots[initialized].cv, NULL);
        if (rc != 0) {
            fprintf(stderr, "[scheduloscope] channel reply condition init failed: %s\n", strerror(rc));
            break;
        }
    }
    if (rc != 0) {
        while (initialized > 0) pthread_cond_destroy(&impl->slots[--initialized].cv);
        pthread_cond_destroy(&impl->available);
        pthread_mutex_destroy(&impl->mu);
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
    for (int i = 0; i < SS_MAX_PENDING; i++) pthread_cond_destroy(&impl->slots[i].cv);
    pthread_cond_destroy(&impl->available);
    pthread_mutex_destroy(&impl->mu);
    free(impl);
    c->impl = NULL;
}

int ss_channel_recv(ss_channel *c, void *buf, size_t len, ss_client_id *client) {
    (void)buf;
    (void)len;
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    pthread_mutex_lock(&impl->mu);
    while (impl->count == 0 && impl->stop_pending == 0) {
        if (pthread_cond_wait(&impl->available, &impl->mu) != 0) {
            pthread_mutex_unlock(&impl->mu);
            return -1;
        }
    }
    if (impl->stop_pending > 0) {
        impl->stop_pending--;
        pthread_mutex_unlock(&impl->mu);
        return 1;
    }
    int slot = impl->queue[impl->head];
    impl->head = (impl->head + 1) % SS_MAX_PENDING;
    impl->count--;
    pthread_mutex_unlock(&impl->mu);
    *client = slot;
    return 0;
}

int ss_channel_reply(ss_channel *c, ss_client_id client, const void *buf, size_t len) {
    (void)buf;
    (void)len;
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl || client < 0 || client >= SS_MAX_PENDING) return -1;
    pthread_mutex_lock(&impl->mu);
    impl->slots[client].state = 2;
    pthread_cond_signal(&impl->slots[client].cv);
    pthread_mutex_unlock(&impl->mu);
    return 0;
}

int ss_channel_send(ss_channel *c, const void *buf, size_t len) {
    (void)buf;
    (void)len;
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    pthread_mutex_lock(&impl->mu);
    int slot = -1;
    for (int i = 0; i < SS_MAX_PENDING; i++) {
        if (impl->slots[i].state == 0) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        pthread_mutex_unlock(&impl->mu);
        return -1;
    }
    impl->slots[slot].state = 1;
    impl->queue[impl->tail] = slot;
    impl->tail = (impl->tail + 1) % SS_MAX_PENDING;
    impl->count++;
    pthread_cond_signal(&impl->available);
    while (impl->slots[slot].state == 1) pthread_cond_wait(&impl->slots[slot].cv, &impl->mu);
    impl->slots[slot].state = 0;
    pthread_mutex_unlock(&impl->mu);
    return 0;
}
int ss_channel_send_stop(ss_channel *c) {
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
#ifdef SS_FORCE_STOP_FAILURE
    return -1;
#endif
    pthread_mutex_lock(&impl->mu);
    impl->stop_pending++;
    pthread_cond_signal(&impl->available);
    pthread_mutex_unlock(&impl->mu);
    return 0;
}
