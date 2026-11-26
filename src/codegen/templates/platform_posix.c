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
                    uint64_t sporadic_replenish_us, void (*entry)(void *), void *arg) {
    (void)sporadic_low_priority;
    (void)sporadic_budget_us;
    (void)sporadic_replenish_us;

    start_args *args = (start_args *)malloc(sizeof(*args));
    if (!args) return -1;
    args->entry = entry;
    args->arg = arg;

    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);

    struct sched_param param;
    memset(&param, 0, sizeof(param));
    param.sched_priority = priority;
    int sched_policy = SCHED_FIFO;
    if (policy == SS_POLICY_RR) sched_policy = SCHED_RR;
    pthread_attr_setschedpolicy(&attr, sched_policy);
    pthread_attr_setschedparam(&attr, &param);

    pthread_t thread;
    int rc = pthread_create(&thread, &attr, trampoline, args);
    if (rc != 0) {
        /* Unprivileged hosts reject real-time priorities; fall back so the
         * harness still runs, and say so once. */
        static int warned;
        if (!warned) {
            fprintf(stderr, "[scheduloscope] cannot set real-time priorities (%s); running with default policy\n", strerror(rc));
            warned = 1;
        }
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
    int queue[SS_MAX_PENDING];
    reply_slot slots[SS_MAX_PENDING];
} channel_impl;

int ss_channel_create(ss_channel *c, int fixed_priority) {
    channel_impl *impl = (channel_impl *)calloc(1, sizeof(*impl));
    if (!impl) return -1;
    pthread_mutex_init(&impl->mu, NULL);
    pthread_cond_init(&impl->available, NULL);
    impl->fixed_priority = fixed_priority;
    for (int i = 0; i < SS_MAX_PENDING; i++) pthread_cond_init(&impl->slots[i].cv, NULL);
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

int ss_channel_recv(ss_channel *c, void *buf, size_t len, int *client) {
    (void)buf;
    (void)len;
    channel_impl *impl = (channel_impl *)c->impl;
    if (!impl) return -1;
    pthread_mutex_lock(&impl->mu);
    while (impl->count == 0) pthread_cond_wait(&impl->available, &impl->mu);
    int slot = impl->queue[impl->head];
    impl->head = (impl->head + 1) % SS_MAX_PENDING;
    impl->count--;
    pthread_mutex_unlock(&impl->mu);
    *client = slot;
    return 0;
}

int ss_channel_reply(ss_channel *c, int client, const void *buf, size_t len) {
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
