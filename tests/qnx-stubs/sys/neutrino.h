/* Minimal QNX declarations so the host preprocessor can check the generated
 * platform_qnx.c. This is not a QNX SDK: -E never type-checks these. */
#ifndef SS_STUB_NEUTRINO_H
#define SS_STUB_NEUTRINO_H

#include <sys/types.h>

#define _NTO_SIDE_CHANNEL 0x40000000
#define _NTO_CHF_FIXED_PRIORITY 0x00000008

struct _msg_info { int stub; };
typedef int rcvid_t;
typedef int chid_t;
typedef int coid_t;

chid_t ChannelCreate(unsigned flags);
int ChannelDestroy(chid_t chid);
coid_t ConnectAttach(unsigned nd, pid_t pid, chid_t chid, unsigned index, int flags);
int ConnectDetach(coid_t coid);
long MsgSend(coid_t coid, const void *smsg, unsigned sbytes, void *rmsg, unsigned rbytes);
rcvid_t MsgReceive(chid_t chid, void *msg, unsigned bytes, struct _msg_info *info);
int MsgReply(rcvid_t rcvid, long status, const void *msg, unsigned bytes);

#endif /* SS_STUB_NEUTRINO_H */
