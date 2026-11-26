/* Minimal sys/procmgr.h stub for preprocessing platform_qnx.c on a host. */
#ifndef SS_STUB_PROCMGR_H
#define SS_STUB_PROCMGR_H

#include <sys/types.h>

#define PROCMGR_ADN_NONROOT 1
#define PROCMGR_AOP_ALLOW 0
#define PROCMGR_AID_PRIORITY 1
#define PROCMGR_AID_EOL 0

int procmgr_ability(pid_t pid, ...);

#endif /* SS_STUB_PROCMGR_H */
