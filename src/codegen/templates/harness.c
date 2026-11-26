/*
 * Scheduloscope measurement harness.
 *
 * Runs the workload described by the generated workload.h on the target and
 * reports observed response times per task. The point is to replace "we think
 * the control loop takes 400 us" with a measurement taken on the board, in the
 * same shape as the analytical model.
 *
 * This file is identical for every generated workload: only workload.h changes.
 */
#include "platform.h"
#include "workload.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint64_t activations;
    uint64_t completed;
    uint64_t min_us;
    uint64_t max_us;
    uint64_t sum_us;
    uint64_t lat_min_us;
    uint64_t lat_max_us;
    uint64_t lat_sum_us;
    uint64_t misses;
    uint64_t skipped;
} task_stats;

static task_stats g_stats[SS_TASK_COUNT];
static ss_mutex g_mutexes[SS_RESOURCE_COUNT > 0 ? SS_RESOURCE_COUNT : 1];
static ss_channel g_channels[SS_CHANNEL_COUNT > 0 ? SS_CHANNEL_COUNT : 1];
static ss_thread g_servers[SS_SERVER_COUNT > 0 ? SS_SERVER_COUNT : 1];
static ss_thread g_tasks[SS_TASK_COUNT > 0 ? SS_TASK_COUNT : 1];
static int g_server_channel[SS_SERVER_COUNT > 0 ? SS_SERVER_COUNT : 1];
#if SS_RESOURCE_COUNT > 0
static int g_mutex_ready;
#endif
#if SS_CHANNEL_COUNT > 0
static int g_channel_ready;
#endif
static int g_server_count;
static int g_task_count;
static uint64_t g_duration_us = SS_DURATION_US;
static uint64_t g_start_us;
static volatile int g_started;
static volatile int g_stop;

static uint64_t next_random(void) {
    static uint64_t state = 0x9e3779b97f4a7c15ull;
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    return state;
}

/*
 * Response time is measured from the nominal release, not from the moment the
 * thread finally ran: a thread that is ready but descheduled has already used
 * part of its deadline, and hiding that would understate every miss.
 */
static void record(int index, uint64_t nominal, uint64_t activation, uint64_t completion, uint64_t deadline) {
    task_stats *stats = &g_stats[index];
    uint64_t response = completion - nominal;
    uint64_t latency = activation - nominal;
    stats->completed++;
    stats->sum_us += response;
    if (stats->min_us == 0 || response < stats->min_us) stats->min_us = response;
    if (response > stats->max_us) stats->max_us = response;
    stats->lat_sum_us += latency;
    if (stats->lat_min_us == 0 || latency < stats->lat_min_us) stats->lat_min_us = latency;
    if (latency > stats->lat_max_us) stats->lat_max_us = latency;
    /* An aperiodic task has no deadline (0) and therefore cannot miss one. */
    if (deadline > 0 && response > deadline) stats->misses++;
}

static void run_segments(const ss_segment *segments, int count) {
    for (int i = 0; i < count; i++) {
        const ss_segment *segment = &segments[i];
        switch (segment->kind) {
            case SS_SEG_CPU:
                ss_spin_us(segment->us);
                break;
            case SS_SEG_CS:
                ss_mutex_lock(&g_mutexes[segment->index]);
                ss_spin_us(segment->us);
                ss_mutex_unlock(&g_mutexes[segment->index]);
                break;
            case SS_SEG_RPC: {
                char message[32] = {0};
                ss_channel_send(&g_channels[segment->index], message, sizeof(message));
                break;
            }
            case SS_SEG_SLEEP:
                ss_sleep_us(segment->us);
                break;
            default:
                break;
        }
    }
}

typedef struct {
    int index;
} task_arg;

typedef struct {
    int channel;
} server_arg;

#if SS_CHANNEL_COUNT > 0
static void server_main(void *raw) {
    server_arg *arg = (server_arg *)raw;
    const ss_channel_def *def = &ss_channel_defs[arg->channel];
    int client = -1;
    char message[64];
    /*
     * A server cannot be stopped by a flag alone: it is blocked in receive. It
     * leaves only after handling one more request, which is the empty wake
     * message stop_servers() sends, so every send has a receiver and no join
     * can hang.
     */
    for (;;) {
        if (ss_channel_recv(&g_channels[arg->channel], message, sizeof(message), &client) != 0) break;
        run_segments(def->handler, def->handler_count);
        ss_channel_reply(&g_channels[arg->channel], client, message, 0);
        if (g_stop) break;
    }
    free(arg);
}
#endif /* SS_CHANNEL_COUNT > 0 */

static void task_main(void *raw) {
    task_arg *arg = (task_arg *)raw;
    int index = arg->index;
    const ss_task_def *task = &ss_tasks[index];
    task_stats *stats = &g_stats[index];
    free(arg);

    while (!g_started && !g_stop) ss_sleep_us(100);
    if (g_stop) return;

    uint64_t next = g_start_us + task->offset_us;
    while (!g_stop) {
        if (next >= g_start_us + g_duration_us) break;
        uint64_t now = ss_now_us();
        if (next > now) ss_sleep_us(next - now);
        uint64_t activation = ss_now_us();

        stats->activations++;
        run_segments(task->segments, task->segment_count);
        uint64_t completion = ss_now_us();
        record(index, next, activation, completion, task->deadline_us);

        if (task->activation == 2) {
            /* Bounded pseudo-random interarrival, same shape as the simulator. */
            uint64_t spread = task->mean_interarrival_us;
            next = completion + spread / 4 + (next_random() % (spread + spread / 2));
        } else {
            next += task->period_us;
            if (next <= completion) {
                stats->skipped++;
                while (next <= completion) next += task->period_us;
            }
        }
    }
}

/*
 * Wake every server thread with one empty request and join it. Servers block in
 * MsgReceive(), so a flag alone would never wake them; joining before the
 * channels are destroyed keeps shutdown ordered and avoids destroying a
 * condition variable while a thread is still waiting on it.
 */
static void stop_servers(void) {
    for (int j = 0; j < g_server_count; j++) {
        char wake = 0;
        ss_channel_send(&g_channels[g_server_channel[j]], &wake, 0);
    }
    for (int j = 0; j < g_server_count; j++) ss_thread_join(&g_servers[j]);
    g_server_count = 0;
}

static void usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s [-d milliseconds] [-o report.json] [-q]\n"
            "  -d  measurement window in milliseconds (default %lu)\n"
            "  -o  write a JSON report to this file\n"
            "  -q  quiet: do not print the summary table\n",
            argv0, (unsigned long)(SS_DURATION_US / 1000));
}

static void json_escape(const char *in, char *out, size_t capacity) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 2 < capacity; i++) {
        char c = in[i];
        if (c == '"' || c == '\\') {
            out[j++] = '\\';
            out[j++] = c;
        } else {
            out[j++] = c;
        }
    }
    out[j] = 0;
}

int main(int argc, char **argv) {
    const char *output = NULL;
    int quiet = 0;
    int rc = 0;
    uint64_t elapsed = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-d") == 0 && i + 1 < argc) {
            g_duration_us = (uint64_t)strtoull(argv[++i], NULL, 10) * 1000ull;
        } else if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) {
            output = argv[++i];
        } else if (strcmp(argv[i], "-q") == 0) {
            quiet = 1;
        } else {
            usage(argv[0]);
            return 2;
        }
    }

    if (ss_init() != 0) {
        fprintf(stderr, "[scheduloscope] platform init failed\n");
        return 1;
    }

#if SS_HAS_INTERRUPTS
    fprintf(stderr,
            "[scheduloscope] the model contains interrupt sources; this harness runs threads, not ISR/IST "
            "handlers, so the measured response times exclude their interference\n");
#endif

#if SS_RESOURCE_COUNT > 0
    for (int i = 0; i < SS_RESOURCE_COUNT; i++) {
        const ss_resource_def *def = &ss_resources[i];
        if (ss_mutex_init(&g_mutexes[i], def->protocol, def->ceiling) != 0) {
            fprintf(stderr, "[scheduloscope] cannot create mutex %s\n", def->name);
            rc = 1;
            goto shutdown;
        }
        g_mutex_ready = i + 1;
    }
#endif

#if SS_CHANNEL_COUNT > 0
    for (int i = 0; i < SS_CHANNEL_COUNT; i++) {
        const ss_channel_def *def = &ss_channel_defs[i];
        if (ss_channel_create(&g_channels[i], def->fixed_priority) != 0) {
            fprintf(stderr, "[scheduloscope] cannot create channel %s\n", def->name);
            rc = 1;
            goto shutdown;
        }
        g_channel_ready = i + 1;
    }
    for (int i = 0; i < SS_CHANNEL_COUNT; i++) {
        const ss_channel_def *def = &ss_channel_defs[i];
        for (int s = 0; s < def->server_threads; s++) {
            server_arg *arg = (server_arg *)malloc(sizeof(*arg));
            if (!arg) {
                rc = 1;
                goto shutdown;
            }
            arg->channel = i;
            if (ss_thread_start(&g_servers[g_server_count], def->name, def->base_priority, SS_POLICY_FIFO, 0, 0, 0, 0,
                                server_main, arg) != 0) {
                fprintf(stderr, "[scheduloscope] cannot start server for %s\n", def->name);
                free(arg);
                rc = 1;
                goto shutdown;
            }
            g_server_channel[g_server_count] = i;
            g_server_count++;
        }
    }
#endif /* SS_CHANNEL_COUNT > 0 */

    g_start_us = ss_now_us();
    g_started = 1;
    for (int i = 0; i < SS_TASK_COUNT; i++) {
        const ss_task_def *def = &ss_tasks[i];
        task_arg *arg = (task_arg *)malloc(sizeof(*arg));
        if (!arg) {
            rc = 1;
            goto shutdown;
        }
        arg->index = i;
        if (ss_thread_start(&g_tasks[i], def->name, def->priority, def->policy, def->sporadic_low_priority,
                            def->sporadic_budget_us, def->sporadic_replenish_us, def->sporadic_max_repl, task_main, arg) != 0) {
            fprintf(stderr, "[scheduloscope] cannot start %s; the measurement is invalid\n", def->name);
            free(arg);
            rc = 1;
            goto shutdown;
        }
        g_task_count = i + 1;
    }

    for (int i = 0; i < g_task_count; i++) ss_thread_join(&g_tasks[i]);
    g_task_count = 0;
    g_stop = 1;
    stop_servers();
    elapsed = ss_now_us() - g_start_us;

    if (!ss_scheduling_enforced()) {
        fprintf(stderr,
                "[scheduloscope] the host did not grant the modelled scheduling policy and priorities; "
                "the report is marked best-effort and is not a measurement of the modelled system\n");
    }

    if (!quiet) {
        printf("%-16s %10s %10s %10s %10s %10s %10s %8s\n", "task", "releases", "completed", "min us", "mean us",
               "max us", "lat max", "misses");
        for (int i = 0; i < SS_TASK_COUNT; i++) {
            const task_stats *stats = &g_stats[i];
            double mean = stats->completed ? (double)stats->sum_us / (double)stats->completed : 0.0;
            printf("%-16s %10" PRIu64 " %10" PRIu64 " %10" PRIu64 " %10.0f %10" PRIu64 " %10" PRIu64 " %8" PRIu64 "\n",
                   ss_tasks[i].name, stats->activations, stats->completed, stats->min_us, mean, stats->max_us,
                   stats->lat_max_us, stats->misses);
        }
        printf("window %.3f s, system %s\n", (double)elapsed / 1e6, SS_SYSTEM_NAME);
    }

    if (output) {
        FILE *file = fopen(output, "w");
        if (!file) {
            fprintf(stderr, "[scheduloscope] cannot write %s\n", output);
            rc = 1;
            goto shutdown;
        }
        char name[128];
        fprintf(file, "{\n  \"system\": ");
        json_escape(SS_SYSTEM_NAME, name, sizeof(name));
        fprintf(file, "\"%s\",\n", name);
        fprintf(file, "  \"duration_us\": %" PRIu64 ",\n", elapsed);
#ifdef __QNX__
        fprintf(file, "  \"platform\": \"qnx\",\n");
#else
        fprintf(file, "  \"platform\": \"posix\",\n");
#endif
        fprintf(file, "  \"scheduling\": \"%s\",\n",
                ss_scheduling_enforced() ? "enforced" : "best-effort");
        fprintf(file,
                "  \"response_time\": \"completion minus nominal release; includes activation latency, "
                "execution and blocking\",\n");
#if SS_HAS_INTERRUPTS
        fprintf(file, "  \"model_includes_interrupts\": true,\n  \"interrupts_reproduced\": false,\n");
#else
        fprintf(file, "  \"model_includes_interrupts\": false,\n  \"interrupts_reproduced\": true,\n");
#endif
        fprintf(file, "  \"tasks\": [\n");
        for (int i = 0; i < SS_TASK_COUNT; i++) {
            const task_stats *stats = &g_stats[i];
            double mean = stats->completed ? (double)stats->sum_us / (double)stats->completed : 0.0;
            double lat_mean = stats->completed ? (double)stats->lat_sum_us / (double)stats->completed : 0.0;
            json_escape(ss_tasks[i].name, name, sizeof(name));
            fprintf(file,
                    "    {\"name\": \"%s\", \"activations\": %" PRIu64 ", \"completed\": %" PRIu64
                    ", \"min_us\": %" PRIu64 ", \"mean_us\": %.1f, \"max_us\": %" PRIu64
                    ", \"max_activation_latency_us\": %" PRIu64 ", \"mean_activation_latency_us\": %.1f"
                    ", \"misses\": %" PRIu64 ", \"skipped\": %" PRIu64 "}%s\n",
                    name, stats->activations, stats->completed, stats->min_us, mean, stats->max_us,
                    stats->lat_max_us, lat_mean, stats->misses, stats->skipped,
                    i + 1 < SS_TASK_COUNT ? "," : "");
        }
        fprintf(file, "  ]\n}\n");
        fclose(file);
    }

    rc = 0;

shutdown:
    g_started = 1;
    g_stop = 1;
    for (int i = 0; i < g_task_count; i++) ss_thread_join(&g_tasks[i]);
    g_task_count = 0;
    stop_servers();
#if SS_CHANNEL_COUNT > 0
    for (int i = g_channel_ready - 1; i >= 0; i--) ss_channel_destroy(&g_channels[i]);
#endif
#if SS_RESOURCE_COUNT > 0
    for (int i = g_mutex_ready - 1; i >= 0; i--) ss_mutex_destroy(&g_mutexes[i]);
#endif
    ss_shutdown();
    return rc;
}
