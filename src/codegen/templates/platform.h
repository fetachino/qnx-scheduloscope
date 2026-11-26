/*
 * Scheduloscope measurement harness - platform interface.
 *
 * The harness is deliberately small and portable so that the same workload can
 * be compiled against QNX OS 8.0 and against a POSIX host. That lets you check
 * the C and the measurement logic before you ever touch a target, and it keeps
 * the QNX-specific code in one file that a reviewer can read in full.
 */
#ifndef SS_PLATFORM_H
#define SS_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

#define SS_POLICY_FIFO 0
#define SS_POLICY_RR 1
#define SS_POLICY_SPORADIC 2

#define SS_PROTO_NONE 0
#define SS_PROTO_INHERIT 1
#define SS_PROTO_PROTECT 2

/* pthread_t is an unsigned long on every platform QNX supports. */
typedef struct ss_thread {
    unsigned long handle;
    int started;
} ss_thread;

typedef struct ss_mutex {
    void *impl;
} ss_mutex;

typedef struct ss_channel ss_channel;

struct ss_channel {
    void *impl;
};

/* Process-wide setup: scheduler privileges, clock calibration. */
int ss_init(void);
void ss_shutdown(void);

/*
 * Non-zero when every thread actually got the scheduling policy and priority
 * the workload asked for. On QNX a thread that cannot be configured is a hard
 * error; on a POSIX host the backend may fall back, and the report then says
 * so instead of pretending the numbers describe the modelled system.
 */
int ss_scheduling_enforced(void);

/* Monotonic microseconds since ss_init(). */
uint64_t ss_now_us(void);

/* Consume CPU for approximately `us` microseconds without yielding. */
void ss_spin_us(uint64_t us);

/* Block the calling thread without consuming CPU. */
void ss_sleep_us(uint64_t us);

int ss_thread_start(ss_thread *t, const char *name, int priority, int policy,
                    int sporadic_low_priority, uint64_t sporadic_budget_us,
                    uint64_t sporadic_replenish_us, int sporadic_max_repl,
                    void (*entry)(void *), void *arg);
int ss_thread_join(ss_thread *t);

int ss_mutex_init(ss_mutex *m, int protocol, int ceiling);
void ss_mutex_destroy(ss_mutex *m);
int ss_mutex_lock(ss_mutex *m);
int ss_mutex_unlock(ss_mutex *m);

int ss_channel_create(ss_channel *c, int fixed_priority);
void ss_channel_destroy(ss_channel *c);
int ss_channel_recv(ss_channel *c, void *buf, size_t len, int *client);
int ss_channel_reply(ss_channel *c, int client, const void *buf, size_t len);
int ss_channel_send(ss_channel *c, const void *buf, size_t len);

#endif /* SS_PLATFORM_H */
