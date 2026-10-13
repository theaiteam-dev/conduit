/*
 * llexec: run a command with its writes confined by Landlock (issue #122).
 *
 *   llexec <writable path>... -- <command> [args...]
 *   llexec --abi
 *
 * The helper creates a Landlock ruleset that handles the write-type file
 * system rights, adds one rule per writable path granting all of them beneath
 * it, sets no_new_privs, restricts itself, and execs the command. Reads and
 * executes are not handled, so they stay allowed everywhere. The restriction
 * is inherited by every descendant and cannot be removed, so a process that
 * calls setsid() or double-forks stays confined.
 *
 * The handled rights follow the highest ABI the kernel reports: ABI 1
 * (Linux 5.13) has the base rights, ABI 2 (5.19) adds REFER, and ABI 3 (6.2)
 * adds TRUNCATE. Under ABI 1 the kernel denies every rename or link across
 * directories, so the call loses those operations even inside its writable
 * paths; under ABI 1 and 2 truncate(2) is not checked.
 *
 * A writable path that is a directory gets every handled right beneath it.
 * A path that is a regular file or another non-directory gets only the rights
 * that apply to a file (write, and truncate where handled). A path that does
 * not exist, or whose final component is a symlink, is an error.
 *
 * The helper never runs the command unconfined. Any failure before the exec
 * (no Landlock, a path that cannot be opened, a syscall error) prints a
 * message starting with "llexec:" on stderr and exits LLEXEC_FAILED. A failed
 * exec exits 127 when the command was not found and 126 otherwise, as a shell
 * does.
 *
 * `--abi` prints the ABI version and exits 0, or exits LLEXEC_FAILED when the
 * kernel has no usable Landlock.
 *
 * Built statically so the engine image can copy it into any base:
 *   cc -static -O2 -o llexec llexec.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The three syscalls share these numbers on every architecture. */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

/* Defined here rather than taken from <linux/landlock.h>, so the helper builds
 * against older kernel headers. Values are the kernel's UAPI. */
#define LL_CREATE_RULESET_VERSION (1U << 0)
#define LL_RULE_PATH_BENEATH 1

#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_REMOVE_DIR (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR (1ULL << 6)
#define LL_FS_MAKE_DIR (1ULL << 7)
#define LL_FS_MAKE_REG (1ULL << 8)
#define LL_FS_MAKE_SOCK (1ULL << 9)
#define LL_FS_MAKE_FIFO (1ULL << 10)
#define LL_FS_MAKE_BLOCK (1ULL << 11)
#define LL_FS_MAKE_SYM (1ULL << 12)
#define LL_FS_REFER (1ULL << 13)
#define LL_FS_TRUNCATE (1ULL << 14)

/* Only the first field is passed: the kernel accepts a shorter struct and
 * treats the network rights it leaves out as not handled. */
struct ll_ruleset_attr {
  uint64_t handled_access_fs;
};

struct ll_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

/* Exit status for every failure before the exec. */
#define LLEXEC_FAILED 121

static int fail(const char *what, const char *detail) {
  if (detail != NULL)
    fprintf(stderr, "llexec: %s: %s\n", what, detail);
  else
    fprintf(stderr, "llexec: %s\n", what);
  return LLEXEC_FAILED;
}

/* The highest Landlock ABI the kernel supports, or -1 with errno set. */
static int landlock_abi(void) {
  return (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_RULESET_VERSION);
}

static int abi_error(void) {
  int err = errno;
  if (err == ENOSYS) return fail("Landlock is not supported by this kernel (requires Linux 5.13 or later)", NULL);
  if (err == EOPNOTSUPP) return fail("Landlock is supported but disabled at boot (add landlock to the lsm= list)", NULL);
  return fail("cannot read the Landlock ABI version", strerror(err));
}

/* The write-type rights the given ABI can handle. */
static uint64_t handled_rights(int abi) {
  uint64_t rights = LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE | LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR |
                    LL_FS_MAKE_REG | LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK | LL_FS_MAKE_SYM;
  if (abi >= 2) rights |= LL_FS_REFER;
  if (abi >= 3) rights |= LL_FS_TRUNCATE;
  return rights;
}

/* The subset of the handled rights that applies to a file that is not a directory. */
static uint64_t file_rights(uint64_t handled) { return handled & (LL_FS_WRITE_FILE | LL_FS_TRUNCATE); }

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    int abi = landlock_abi();
    if (abi < 0) return abi_error();
    if (abi < 1) return fail("the kernel reports no usable Landlock ABI", NULL);
    printf("%d\n", abi);
    return 0;
  }

  int sep = -1;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) {
      sep = i;
      break;
    }
  }
  if (sep < 0 || sep + 1 >= argc) {
    fprintf(stderr, "usage: llexec <writable path>... -- <command> [args...]\n       llexec --abi\n");
    return LLEXEC_FAILED;
  }

  int abi = landlock_abi();
  if (abi < 0) return abi_error();
  if (abi < 1) return fail("the kernel reports no usable Landlock ABI", NULL);
  uint64_t handled = handled_rights(abi);

  struct ll_ruleset_attr ruleset = {.handled_access_fs = handled};
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) return fail("cannot create a Landlock ruleset", strerror(errno));

  for (int i = 1; i < sep; i++) {
    const char *path = argv[i];
    /* O_NOFOLLOW: the kernel passes canonical paths, so a final symlink means
     * the path was swapped after admission; refuse it rather than grant the
     * link's target. With O_PATH the open succeeds on the link itself, so
     * the fstat below checks for it. */
    int fd = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
      fprintf(stderr, "llexec: cannot open writable path %s: %s\n", path, strerror(errno));
      return LLEXEC_FAILED;
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
      fprintf(stderr, "llexec: cannot stat writable path %s: %s\n", path, strerror(errno));
      return LLEXEC_FAILED;
    }
    if (S_ISLNK(st.st_mode)) {
      fprintf(stderr, "llexec: cannot open writable path %s: it is a symbolic link\n", path);
      return LLEXEC_FAILED;
    }
    struct ll_path_beneath_attr rule = {
        .allowed_access = S_ISDIR(st.st_mode) ? handled : file_rights(handled),
        .parent_fd = fd,
    };
    if (syscall(__NR_landlock_add_rule, ruleset_fd, LL_RULE_PATH_BENEATH, &rule, 0) != 0) {
      fprintf(stderr, "llexec: cannot add a Landlock rule for %s: %s\n", path, strerror(errno));
      return LLEXEC_FAILED;
    }
    close(fd);
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("cannot set no_new_privs", strerror(errno));
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    return fail("cannot apply the Landlock ruleset", strerror(errno));
  }
  close(ruleset_fd);

  execvp(argv[sep + 1], &argv[sep + 1]);
  int err = errno;
  fprintf(stderr, "llexec: cannot run %s: %s\n", argv[sep + 1], strerror(err));
  return err == ENOENT ? 127 : 126;
}
