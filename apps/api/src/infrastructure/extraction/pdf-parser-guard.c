/* Trusted Linux launcher: deny all sockets before exec; bound CPU time.
 * Node permissions additionally deny writes, child processes and native addons.
 * Parent enforces wall time and Node heap; container bounds total RSS. */
#include <errno.h>
#include <stddef.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#if defined(__x86_64__)
#define QYVRA_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define QYVRA_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported PDF sandbox architecture
#endif
int main(int argc, char **argv) {
  if (argc < 4) return 125;
  char *end;
  long seconds = strtol(argv[1], &end, 10);
  if (*end || seconds < 1 || seconds > 3601) return 125;
  struct rlimit cpu = { (rlim_t)seconds, (rlim_t)seconds };
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, QYVRA_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* Reject x32 ABI, which can otherwise bypass syscall-number checks. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { sizeof(filter) / sizeof(filter[0]), filter };
  if (setrlimit(RLIMIT_CPU, &cpu) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 125;
  execv(argv[2], &argv[2]);
  return 125;
}
