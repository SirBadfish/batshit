/* BL-320: one killable reader holds the admitted project directory for a reply.
 * Build: cc -std=c11 -O2 -Wall -Wextra -Werror anchored-project-reader.c -o ...
 * argv: absolute configured project root, absolute trusted Git executable.
 * Protocol: 16-byte BE header: "B320", version 1, kind, zeroes, id, length.
 * Requests: 1=READ(u32 byte cap + relative path), 2=STAT(relative path),
 * 3=GIT(op byte + optional relative path or lowercase object id).
 * Git ops: 1=rev-parse --show-prefix, 2=ls-files metadata, 3=check-attr,
 * 4=ls-files --stage, 5=cat-file blob. Responses: 128=READY(dev,ino),
 * 129=READ(bytes), 130=STAT(size,dev,ino,ctimeNs,mtimeNs), 131=GIT(bytes),
 * 255=ERROR(short ASCII code). A failed request publishes no content bytes.
 * Only one request may be in flight. The parent closes stdin on normal release;
 * TERM asks this helper to kill/reap its exact Git child before exiting.
 *
 * BL-2006 writer mode, SA-136 protocol v2. argv: --write-v2, absolute configured project root. It admits
 * the root exactly as the reader does and never runs Git. Requests (relative paths
 * as above; nothing is followed and no mount is crossed, at any component):
 * 16=LSTAT(path), 17=READ(u32 byte cap + path), 18=WRITE(u8 kind 1=create-new
 * 2=replace, u8 flags bit0=fsync, bit1=exact mode (create-new only), two zeroes,
 * u32 create mode (0 = 0666 unless exact mode), u32 path
 * length, path, bytes), 19=MKDIR(path), 20=RENAME(u32 source length, source,
 * destination), 21=UNLINK(path), 22=RMDIR(path), 23=PROBE_WRITABLE(path; no data
 * or mode change). Responses: 128=READY as above, 144=LSTAT(stat56),
 * 145=READ(stat56 + bytes), 146=WRITE(stat56 after writing), 147=DONE,
 * 148=PROBE_WRITABLE(stat56), 255=ERROR("<stage>:<errno name>"). stat56: u8 type (0 absent,
 * 1 file, 2 link, 3 folder, 4 other, 5 a folder in the path is not a folder),
 * three zeroes, u32 mode, u64 size, dev, ino, ctimeNs, mtimeNs, nlink. Each operation
 * holds the target's parent folder as a descriptor opened beneath the root, then
 * acts on the last component relative to it, so a folder swapped for a link at
 * any moment can only make the operation fail or land in the held folder. The
 * reader mode refuses every writer request, and the writer every reader request.
 */
#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__linux__) && !defined(__APPLE__)
#error "BL-320 anchored reader requires the reviewed Linux or macOS confinement primitive"
#endif
#ifdef __linux__
#include <linux/openat2.h>
#include <linux/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#endif

/* BL-2046: Linux shared filesystems can initially cache a newly-created directory's
 * provisional inode. A later synchronized lookup (including Node's) then reports its backing
 * inode, falsely resembling replacement. Admit synchronized directory metadata at every native
 * snapshot instead of accepting an identity change or using an unconfined host-path lookup.
 * Regular-file snapshots and macOS keep their existing syscalls. No cached fallback. */
#ifdef __linux__
static void barrier(const char *stage);
static int sync_directory_metadata_at(int parent, const char *name, struct stat *st, int flags) {
  if (!S_ISDIR(st->st_mode)) return 0;
  struct statx fresh;
  const unsigned int required = STATX_TYPE | STATX_INO;
  if (syscall(SYS_statx, parent, name, flags | AT_NO_AUTOMOUNT | AT_STATX_FORCE_SYNC,
      required, &fresh)) return -1;
  if ((fresh.stx_mask & required) != required) { errno = EOPNOTSUPP; return -1; }
  barrier("directory-stat-synchronized");
  if (fstatat(parent, name, st, flags)) return -1;
  if (!S_ISDIR(fresh.stx_mode) || !S_ISDIR(st->st_mode) ||
      (uint64_t)st->st_ino != fresh.stx_ino ||
      major(st->st_dev) != fresh.stx_dev_major || minor(st->st_dev) != fresh.stx_dev_minor) {
    errno = EAGAIN;
    return -1;
  }
  return 0;
}
static int metadata_stat_at(int parent, const char *name, struct stat *st, int flags) {
  if (fstatat(parent, name, st, flags)) return -1;
  return sync_directory_metadata_at(parent, name, st, flags);
}
static int metadata_fstat(int fd, struct stat *st) {
  if (fstat(fd, st)) return -1;
  return sync_directory_metadata_at(fd, "", st, AT_EMPTY_PATH);
}
#else
#define metadata_stat_at fstatat
#define metadata_fstat fstat
#endif

#define FILE_CAP 8000000u
#define GIT_CAP 5000000u
#define REQUEST_CAP 4100u /* READ's four-byte cap plus a 4096-byte relative path. */
#define WRITE_CAP 67108864u /* BL-2006: 64 MiB per patched file. */
/* WRITE's twelve-byte head, a 4096-byte path and its bytes. */
#define WRITER_REQUEST_CAP (WRITE_CAP + 12u + 4096u)
static int rootfd = -1;
static pid_t git_child = -1;
static volatile sig_atomic_t stopped = 0;
static int wake_pipe[2] = {-1, -1};
static char *git_executable = NULL;
static char *git_environment[7] = {
  "GIT_NO_LAZY_FETCH=1", "LC_ALL=C", "PATH=/usr/bin:/bin", NULL
};
static void die(const char *reason);

static char *optional_absolute_environment(const char *name) {
  const char *value = getenv(name);
  if (!value) return NULL;
  if (value[0] != '/' || strlen(value) > 4096) die("git-environment");
  size_t name_size = strlen(name), value_size = strlen(value);
  char *entry = malloc(name_size + value_size + 2);
  if (!entry) die("git-environment");
  memcpy(entry, name, name_size);
  entry[name_size] = '=';
  memcpy(entry + name_size + 1, value, value_size + 1);
  return entry;
}
static void prepare_git_environment(void) {
  size_t next = 3;
  char *home = optional_absolute_environment("HOME");
  char *xdg = optional_absolute_environment("XDG_CONFIG_HOME");
  if (home) git_environment[next++] = home;
  if (xdg) git_environment[next++] = xdg;
#ifdef BL320_TEST_BARRIERS
  // The test-only fake Git records its exact PID. Never pass this in production.
  const char *pid_file = getenv("BL320_GIT_PID_FILE");
  if (pid_file && pid_file[0] == '/' && strlen(pid_file) <= 4096) {
    size_t length = strlen(pid_file);
    char *entry = malloc(sizeof("BL320_GIT_PID_FILE=") + length);
    if (!entry) die("test-environment");
    memcpy(entry, "BL320_GIT_PID_FILE=", sizeof("BL320_GIT_PID_FILE=") - 1);
    memcpy(entry + sizeof("BL320_GIT_PID_FILE=") - 1, pid_file, length + 1);
    git_environment[next++] = entry;
  }
#endif
  git_environment[next] = NULL;
}

static void wake_loop(void) {
  int saved_errno = errno;
  if (wake_pipe[1] >= 0) {
    const char byte = 1;
    ssize_t ignored = write(wake_pipe[1], &byte, 1);
    (void)ignored; /* A full nonblocking pipe already has a pending wakeup. */
  }
  errno = saved_errno;
}
static void on_stop(int signal_number) { (void)signal_number; stopped = 1; wake_loop(); }
static void on_child(int signal_number) { (void)signal_number; wake_loop(); }
static void set_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) die("nonblocking");
}
static void prepare_wakeup(void) {
  if (pipe(wake_pipe)) die("wake-pipe");
  for (size_t n = 0; n < 2; n++) {
    int flags = fcntl(wake_pipe[n], F_GETFD);
    if (flags < 0 || fcntl(wake_pipe[n], F_SETFD, flags | FD_CLOEXEC) < 0) die("wake-cloexec");
    set_nonblocking(wake_pipe[n]);
  }
  set_nonblocking(0);
  set_nonblocking(1);
}
static int wait_ready(int fd, short events) {
  for (;;) {
    if (stopped) return -1;
    struct pollfd watched[2] = {{.fd = wake_pipe[0], .events = POLLIN}, {.fd = fd, .events = events}};
    int count = poll(watched, fd < 0 ? 1 : 2, -1);
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    if (watched[0].revents) {
      char bytes[64];
      while (read(wake_pipe[0], bytes, sizeof(bytes)) > 0) {}
      if (stopped) return -1;
    }
    if (fd >= 0 && watched[1].revents) return 0;
    if (fd < 0) return 0; /* SIGCHLD: re-check waitpid. */
  }
}
static void reap_git(void) {
  if (git_child <= 0) return;
  kill(git_child, SIGKILL); /* Exact unreaped child PID cannot have been reused. */
  while (waitpid(git_child, NULL, 0) < 0 && errno == EINTR) {}
  git_child = -1;
}
static void die(const char *reason) {
  reap_git();
  fprintf(stderr, "anchored-reader:%s:%d\n", reason, errno);
  exit(2);
}
static void barrier(const char *stage) {
#ifdef BL320_TEST_BARRIERS
  if (fcntl(3, F_GETFD) < 0) return;
  if (dprintf(3, "%s\n", stage) < 0) die("barrier-output");
  char answer = 0;
  ssize_t n;
  do {
    if (wait_ready(3, POLLIN) < 0) die("stopped");
    n = read(3, &answer, 1);
  } while (n < 0 && (errno == EINTR || errno == EAGAIN));
  if (stopped) die("stopped");
  if (n != 1 || answer != '+') die("barrier-input");
#else
  (void)stage;
#endif
}
static uint32_t get32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void put32(unsigned char *p, uint32_t n) {
  p[0] = (unsigned char)(n >> 24); p[1] = (unsigned char)(n >> 16);
  p[2] = (unsigned char)(n >> 8); p[3] = (unsigned char)n;
}
static void put64(unsigned char *p, uint64_t n) {
  put32(p, (uint32_t)(n >> 32)); put32(p + 4, (uint32_t)n);
}
static int exact_read(int fd, void *out, size_t size) {
  size_t used = 0;
  while (used < size) {
    if (wait_ready(fd, POLLIN) < 0) return -1;
    ssize_t n = read(fd, (unsigned char *)out + used, size - used);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n <= 0) return n ? -1 : (used ? -1 : 0);
    used += (size_t)n;
  }
  return 1;
}
static void exact_write(int fd, const void *bytes, size_t size) {
  size_t sent = 0;
  while (sent < size) {
    if (wait_ready(fd, POLLOUT) < 0) die("stopped");
    ssize_t n = write(fd, (const unsigned char *)bytes + sent, size - sent);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n <= 0) die("protocol-output");
    sent += (size_t)n;
  }
}
static void frame(unsigned char kind, uint32_t id, const void *body, uint32_t length) {
  unsigned char header[16] = {'B','3','2','0',1,kind,0,0};
  put32(header + 8, id); put32(header + 12, length);
  exact_write(1, header, sizeof(header));
  if (length) exact_write(1, body, length);
}
static void error_frame(uint32_t id, const char *reason) {
  frame(255, id, reason, (uint32_t)strlen(reason));
}
static int relative_ok(const char *name) {
  size_t length = strlen(name);
  if (!length || length > 4096 || name[0] == '/') return 0;
  const char *part = name;
  for (const char *p = name;; p++) {
    if (*p && *p != '/') continue;
    size_t n = (size_t)(p - part);
    if (!n || (n == 1 && part[0] == '.') ||
        (n == 2 && part[0] == '.' && part[1] == '.')) return 0;
    if (!*p) return 1;
    part = p + 1;
  }
}
static int same_file(const struct stat *a, const struct stat *b) {
#ifdef __APPLE__
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}
static int stat_times_ns(const struct stat *st, uint64_t *ctime_ns, uint64_t *mtime_ns) {
#ifdef __APPLE__
  const time_t csec = st->st_ctimespec.tv_sec, msec = st->st_mtimespec.tv_sec;
  const long cnsec = st->st_ctimespec.tv_nsec, mnsec = st->st_mtimespec.tv_nsec;
#else
  const time_t csec = st->st_ctim.tv_sec, msec = st->st_mtim.tv_sec;
  const long cnsec = st->st_ctim.tv_nsec, mnsec = st->st_mtim.tv_nsec;
#endif
  if (csec < 0 || msec < 0 || cnsec < 0 || mnsec < 0 ||
      cnsec >= 1000000000L || mnsec >= 1000000000L ||
      (uint64_t)csec > (UINT64_MAX - (uint64_t)cnsec) / 1000000000u ||
      (uint64_t)msec > (UINT64_MAX - (uint64_t)mnsec) / 1000000000u) return 0;
  *ctime_ns = (uint64_t)csec * 1000000000u + (uint64_t)cnsec;
  *mtime_ns = (uint64_t)msec * 1000000000u + (uint64_t)mnsec;
  return 1;
}
static int confined_open(const char *name, int test_barrier) {
#ifdef __linux__
  if (test_barrier) barrier("before-leaf");
  struct open_how how = {
    .flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
  };
  return (int)syscall(SYS_openat2, rootfd, name, &how, sizeof(how));
#elif defined(__APPLE__)
  struct stat root_stat;
  if (metadata_fstat(rootfd, &root_stat)) return -1;
  int parent = dup(rootfd);
  if (parent < 0) return -1;
  char *copy = strdup(name), *part = copy;
  if (!copy) { close(parent); return -1; }
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = 0;
    if (test_barrier) barrier(slash ? "before-directory" : "before-leaf");
    int next = openat(parent, part, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK |
      (slash ? O_DIRECTORY : 0));
    int saved = errno;
    close(parent);
    if (next < 0) { free(copy); errno = saved; return -1; }
    struct stat st;
    if (metadata_fstat(next, &st) || st.st_dev != root_stat.st_dev || (slash && !S_ISDIR(st.st_mode))) {
      close(next); free(copy); errno = EXDEV; return -1;
    }
    if (!slash) { free(copy); return next; }
    parent = next;
    if (test_barrier) barrier("directory-held");
    part = slash + 1;
  }
#else
  (void)name; (void)test_barrier; errno = ENOTSUP; return -1;
#endif
}
static void admit(const char *configured) {
  if (configured[0] != '/' || strlen(configured) > 4096) die("root-path");
  // Bind the object first. If the configured path changes during realpath or
  // the subsequent component walk, its identity cannot silently change roots.
  // The configured target at this first open is the admission authority.
  barrier("admit-before-open");
  rootfd = open(configured, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (rootfd < 0) die("root-open");
  struct stat admitted, checked;
  if (metadata_fstat(rootfd, &admitted) || !S_ISDIR(admitted.st_mode)) die("root-fstat");
  barrier("admit-before-realpath");
  char *canonical = realpath(configured, NULL);
  if (!canonical || canonical[0] != '/' || !canonical[1] || !relative_ok(canonical + 1)) die("root-realpath");
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) die("system-root");
  char *part = canonical + 1;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = 0;
    barrier("admit-before-component");
    int next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno; close(parent);
    if (next < 0) { errno = saved; die("root-component"); }
    parent = next;
    if (!slash) break;
    part = slash + 1;
  }
  if (metadata_fstat(parent, &checked) || checked.st_dev != admitted.st_dev || checked.st_ino != admitted.st_ino)
    die("root-identity");
  close(parent); free(canonical);
}
static void admit_git(const char *configured) {
  if (configured[0] != '/' || strlen(configured) > 4096) die("git-path");
  barrier("git-before-realpath");
  git_executable = realpath(configured, NULL);
  if (!git_executable || git_executable[0] != '/') die("git-realpath");
  struct stat st;
  if (stat(git_executable, &st) || !S_ISREG(st.st_mode) ||
      access(git_executable, X_OK)) die("git-executable");
}
static void put_stat56(unsigned char *out, unsigned char type, const struct stat *st);
/* `reply` 129 is the reader's READ; the writer's 145 puts the read file's stat56 first. */
static void file_request(unsigned char kind, uint32_t id, char *name, uint32_t limit, unsigned char reply) {
  if (!relative_ok(name)) { error_frame(id, "relative-path"); return; }
  int file = confined_open(name, 1);
  if (file < 0) { error_frame(id, "confined-open"); return; }
  struct stat before, after;
  if (metadata_fstat(file, &before) || !S_ISREG(before.st_mode) || before.st_size < 0 ||
      (uint64_t)before.st_size > limit) {
    close(file); error_frame(id, "ordinary-bounded-file"); return;
  }
  if (kind == 2) {
    int verify = confined_open(name, 0);
    int valid = verify >= 0 && metadata_fstat(verify, &after) == 0 && same_file(&before, &after);
    if (verify >= 0) close(verify);
    if (!valid) { close(file); error_frame(id, "name-changed"); return; }
    uint64_t ctime_ns, mtime_ns;
    if (!stat_times_ns(&before, &ctime_ns, &mtime_ns)) {
      close(file); error_frame(id, "stat-time-range"); return;
    }
    unsigned char stat_body[40];
    put64(stat_body, (uint64_t)before.st_size);
    put64(stat_body + 8, (uint64_t)before.st_dev);
    put64(stat_body + 16, (uint64_t)before.st_ino);
    put64(stat_body + 24, ctime_ns);
    put64(stat_body + 32, mtime_ns);
    close(file); frame(130, id, stat_body, sizeof(stat_body)); return;
  }
  barrier("file-held");
  const size_t head = reply == 145 ? 56u : 0u;
  unsigned char *buffer = malloc(head + (size_t)limit + 1u);
  if (!buffer) die("allocation");
  unsigned char *bytes = buffer + head;
  size_t used = 0;
  while (used <= limit) {
    ssize_t n = read(file, bytes + used, (size_t)limit + 1u - used);
    if (n < 0 && errno == EINTR) { if (stopped) die("stopped"); continue; }
    if (n < 0) { close(file); free(buffer); error_frame(id, "read"); return; }
    if (!n) break;
    used += (size_t)n;
  }
  barrier("read-finished");
  int verify = confined_open(name, 0);
  int valid = used <= limit && metadata_fstat(file, &after) == 0 && same_file(&before, &after) &&
    used == (size_t)after.st_size && verify >= 0 && metadata_fstat(verify, &after) == 0 &&
    same_file(&before, &after);
  if (verify >= 0) close(verify);
  close(file);
  if (valid && head) put_stat56(buffer, 1, &before);
  if (valid) frame(reply, id, buffer, (uint32_t)(head + used));
  else error_frame(id, "changed-or-oversize");
  free(buffer);
}
static void git_request(uint32_t id, unsigned char *request, uint32_t length) {
  if (!length) { error_frame(id, "git-op"); return; }
  unsigned char op = request[0];
  char *arg = (char *)request + 1;
  if (length == 1) arg = "";
  else if (memchr(arg, 0, length - 1)) { error_frame(id, "git-argument"); return; }
  if (op < 1 || op > 5 || ((op == 1 || op == 2) && length != 1) ||
      ((op == 3 || op == 4) && (length == 1 || !relative_ok(arg))) ||
      (op == 5 && ((length != 41 && length != 65) || strspn(arg, "0123456789abcdef") != strlen(arg)))) {
    error_frame(id, "git-argument"); return;
  }
  char *common[] = {git_executable, "-c", "core.fsmonitor=false", "--no-optional-locks", "--literal-pathspecs", NULL};
  char *rev[] = {"rev-parse", "--show-prefix", NULL};
  char *list[] = {"ls-files", "-v", "--stage", "--debug", "-z", "--", ".", NULL};
  char *attrs[] = {"check-attr", "-z", "filter", "text", "eol", "ident", "working-tree-encoding", "--", arg, NULL};
  char *stage[] = {"ls-files", "-v", "--stage", "-z", "--", arg, NULL};
  char *blob[] = {"cat-file", "blob", arg, NULL};
  char **tail = op == 1 ? rev : op == 2 ? list : op == 3 ? attrs : op == 4 ? stage : blob;
  char *argv[24]; size_t count = 0;
  for (size_t n = 0; common[n]; n++) argv[count++] = common[n];
  for (size_t n = 0; tail[n]; n++) argv[count++] = tail[n];
  argv[count] = NULL;
  int pipes[2];
  if (pipe(pipes)) { error_frame(id, "git-pipe"); return; }
  git_child = fork();
  if (git_child < 0) { close(pipes[0]); close(pipes[1]); error_frame(id, "git-fork"); return; }
  if (!git_child) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    close(pipes[0]);
    if (dup2(pipes[1], 1) < 0 || fchdir(rootfd)) _exit(126);
    close(pipes[1]); close(rootfd); close(3);
    if (stopped) _exit(125);
    execve(git_executable, argv, git_environment); _exit(127);
  }
  close(pipes[1]);
  set_nonblocking(pipes[0]);
  if (stopped) die("stopped");
  barrier("git-child-started");
  unsigned char *bytes = malloc(GIT_CAP + 1u);
  if (!bytes) die("allocation");
  size_t used = 0; int bad = 0;
  while (used <= GIT_CAP) {
    if (wait_ready(pipes[0], POLLIN) < 0) die("stopped");
    ssize_t n = read(pipes[0], bytes + used, GIT_CAP + 1u - used);
    if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (n < 0) { bad = 1; break; }
    if (!n) break;
    used += (size_t)n;
    barrier("git-output-read");
  }
  close(pipes[0]);
  if (stopped) die("stopped");
  if (used > GIT_CAP) bad = 1;
  if (bad) { reap_git(); free(bytes); error_frame(id, "git-output"); return; }
  int status = 0;
  for (;;) {
    pid_t result = waitpid(git_child, &status, WNOHANG);
    if (result == git_child) break;
    if (result < 0 && errno == EINTR) continue;
    if (result < 0) die("git-wait");
    if (wait_ready(-1, 0) < 0) die("stopped");
  }
  git_child = -1;
  if (stopped) die("stopped");
  if (WIFEXITED(status) && WEXITSTATUS(status) == 0) frame(131, id, bytes, (uint32_t)used);
  else error_frame(id, "git-exit");
  free(bytes);
}

/* ---- BL-2006 writer mode ---------------------------------------------------- */

static const char *errno_name(int error) {
  switch (error) {
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ELOOP: return "ELOOP";
    case EXDEV: return "EXDEV";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case ENOSPC: return "ENOSPC";
    case EDQUOT: return "EDQUOT";
    case EROFS: return "EROFS";
    case EIO: return "EIO";
    case EFBIG: return "EFBIG";
    case EBUSY: return "EBUSY";
    case EAGAIN: return "EAGAIN";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    case ENXIO: return "ENXIO";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ESTALE: return "ESTALE";
    default: return "EOTHER";
  }
}
static void errno_frame(uint32_t id, const char *stage, int error) {
  char reason[64];
  int n = snprintf(reason, sizeof(reason), "%s:%s", stage, errno_name(error));
  if (n < 0 || (size_t)n >= sizeof(reason)) die("error-frame");
  error_frame(id, reason);
}
static void put_stat56(unsigned char *out, unsigned char type, const struct stat *st) {
  memset(out, 0, 56);
  out[0] = type;
  if (!st) return;
  uint64_t ctime_ns = 0, mtime_ns = 0;
  if (!stat_times_ns(st, &ctime_ns, &mtime_ns)) ctime_ns = mtime_ns = 0;
  put32(out + 4, (uint32_t)st->st_mode);
  put64(out + 8, st->st_size < 0 ? 0 : (uint64_t)st->st_size);
  put64(out + 16, (uint64_t)st->st_dev);
  put64(out + 24, (uint64_t)st->st_ino);
  put64(out + 32, ctime_ns);
  put64(out + 40, mtime_ns);
  put64(out + 48, (uint64_t)st->st_nlink);
}
#ifndef __linux__
/* macOS has no RESOLVE_NO_XDEV: each held descriptor is checked against the root's device. */
static int same_device_as_root(int fd) {
  struct stat st, root;
  if (metadata_fstat(fd, &st) || metadata_fstat(rootfd, &root)) return 0;
  if (st.st_dev != root.st_dev) { errno = EXDEV; return 0; }
  return 1;
}
#endif
/* The folder `folder` ("" is the root) beneath the held root as a descriptor: no
 * component may be a link, `..` or another mount. */
static int confined_folder(const char *folder) {
  if (!*folder) return fcntl(rootfd, F_DUPFD_CLOEXEC, 0);
#ifdef __linux__
  // RESOLVE_NO_SYMLINKS refuses a link at every component, the last included (ELOOP); O_NOFOLLOW
  // would only turn a last-component link into ENOTDIR.
  struct open_how how = {
    .flags = O_RDONLY | O_CLOEXEC | O_DIRECTORY,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
  };
  return (int)syscall(SYS_openat2, rootfd, folder, &how, sizeof(how));
#elif defined(__APPLE__)
  int parent = fcntl(rootfd, F_DUPFD_CLOEXEC, 0);
  if (parent < 0) return -1;
  char *copy = strdup(folder), *part = copy;
  if (!copy) { close(parent); return -1; }
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = 0;
    int next = openat(parent, part, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY);
    int saved = errno;
    // macOS answers a link here with ENOTDIR; name it a link, as Linux's openat2 does (ELOOP).
    struct stat link;
    if (next < 0 && saved == ENOTDIR && !metadata_stat_at(parent, part, &link, AT_SYMLINK_NOFOLLOW) &&
        S_ISLNK(link.st_mode)) saved = ELOOP;
    close(parent);
    if (next < 0) { free(copy); errno = saved; return -1; }
    if (!same_device_as_root(next)) { saved = errno; close(next); free(copy); errno = saved; return -1; }
    if (!slash) { free(copy); return next; }
    parent = next;
    part = slash + 1;
  }
#else
  (void)folder; errno = ENOTSUP; return -1;
#endif
}
/* Splits a checked relative `name` in place and holds its parent folder; `*leaf`
 * is the last component, which every caller acts on relative to the descriptor. */
static int confined_parent(char *name, const char **leaf) {
  char *slash = strrchr(name, '/');
  if (!slash) { *leaf = name; return confined_folder(""); }
  *slash = 0;
  *leaf = slash + 1;
  int parent = confined_folder(name);
  int saved = errno;
  *slash = '/';
  errno = saved;
  return parent;
}
/* Opens the last component relative to its held folder without following it or
 * leaving the root's file system. */
static int confined_leaf_open(int parent, const char *leaf, int flags, mode_t mode) {
#ifdef __linux__
  struct open_how how = {
    .flags = (uint64_t)(flags | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY),
    .mode = (flags & O_CREAT) ? (uint64_t)mode : 0,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
  };
  return (int)syscall(SYS_openat2, parent, leaf, &how, sizeof(how));
#else
  int fd = openat(parent, leaf, flags | O_NOFOLLOW | O_CLOEXEC | O_NOCTTY, mode);
  if (fd < 0) return -1;
  if (!same_device_as_root(fd)) { int saved = errno; close(fd); errno = saved; return -1; }
  return fd;
#endif
}
/* A relative path from a request: NUL-free, at most 4096 bytes, and `relative_ok`. */
static int writer_name(const unsigned char *bytes, uint32_t length, char *out) {
  if (!length || length > 4096 || memchr(bytes, 0, length)) return 0;
  memcpy(out, bytes, length);
  out[length] = 0;
  return relative_ok(out);
}
static void lstat_request(uint32_t id, char *name) {
  const char *leaf;
  unsigned char body[56];
  int parent = confined_parent(name, &leaf);
  if (parent < 0) {
    if (errno == ENOENT) { put_stat56(body, 0, NULL); frame(144, id, body, sizeof(body)); }
    else if (errno == ENOTDIR) { put_stat56(body, 5, NULL); frame(144, id, body, sizeof(body)); }
    else errno_frame(id, "parent", errno);
    return;
  }
  barrier("writer-parent-held");
  struct stat st;
  int failed = metadata_stat_at(parent, leaf, &st, AT_SYMLINK_NOFOLLOW);
  int saved = errno;
  close(parent);
  if (failed) {
    if (saved == ENOENT) { put_stat56(body, 0, NULL); frame(144, id, body, sizeof(body)); }
    else errno_frame(id, "leaf", saved);
    return;
  }
  unsigned char type = S_ISREG(st.st_mode) ? 1 : S_ISLNK(st.st_mode) ? 2 : S_ISDIR(st.st_mode) ? 3 : 4;
  put_stat56(body, type, &st);
  frame(144, id, body, sizeof(body));
}
static void write_request(uint32_t id, const unsigned char *payload, uint32_t length) {
  char name[4097];
  if (length < 12) { error_frame(id, "write-input"); return; }
  const unsigned char kind = payload[0], flags = payload[1];
  const uint32_t mode = get32(payload + 4), name_length = get32(payload + 8);
  if ((kind != 1 && kind != 2) || (flags & ~3u) || ((flags & 2u) && kind != 1) ||
      payload[2] || payload[3] || mode > 0777 ||
      name_length > length - 12 || !writer_name(payload + 12, name_length, name)) {
    error_frame(id, "write-input"); return;
  }
  const unsigned char *bytes = payload + 12 + name_length;
  const size_t size = length - 12 - name_length;
  if (size > WRITE_CAP) { error_frame(id, "write-input"); return; }
  const char *leaf;
  int parent = confined_parent(name, &leaf);
  if (parent < 0) { errno_frame(id, "parent", errno); return; }
  barrier("writer-parent-held");
  struct stat st;
  // A replace refuses a name that is there and not a regular file without opening it. One
  // swapped in after this check (a device, FIFO or socket) opens without blocking or a
  // controlling terminal and is refused before any byte; a link or a folder never opens.
  if (kind == 2) {
    const int found = metadata_stat_at(parent, leaf, &st, AT_SYMLINK_NOFOLLOW);
    if (found < 0 && errno != ENOENT) {
      const int saved = errno;
      close(parent); errno_frame(id, "leaf", saved); return;
    }
    if (found == 0 && !S_ISREG(st.st_mode)) {
      close(parent); error_frame(id, S_ISLNK(st.st_mode) ? "leaf:ELOOP" : "leaf:ENOTREG"); return;
    }
  }
  int file = confined_leaf_open(parent, leaf, O_WRONLY | O_NONBLOCK | O_CREAT | (kind == 1 ? O_EXCL : 0),
    (mode || (flags & 2u)) ? (mode_t)mode : 0666);
  int saved = errno;
  close(parent);
  if (file < 0) { errno_frame(id, "leaf", saved); return; }
  if (metadata_fstat(file, &st)) { saved = errno; close(file); errno_frame(id, "fstat", saved); return; }
  if (!S_ISREG(st.st_mode)) { close(file); error_frame(id, "leaf:ENOTREG"); return; }
  if (kind == 2 && ftruncate(file, 0)) { saved = errno; close(file); errno_frame(id, "truncate", saved); return; }
  size_t sent = 0;
  while (sent < size) {
    ssize_t n = write(file, bytes + sent, size - sent);
    if (n < 0 && errno == EINTR) { if (stopped) die("stopped"); continue; }
    if (n <= 0) { saved = n < 0 ? errno : EIO; close(file); errno_frame(id, "write", saved); return; }
    sent += (size_t)n;
  }
  if ((flags & 2u) && fchmod(file, (mode_t)mode)) { saved = errno; close(file); errno_frame(id, "chmod", saved); return; }
  if ((flags & 1u) && fsync(file)) { saved = errno; close(file); errno_frame(id, "fsync", saved); return; }
  if (metadata_fstat(file, &st)) { saved = errno; close(file); errno_frame(id, "fstat", saved); return; }
  if (close(file)) { errno_frame(id, "close", errno); return; }
  unsigned char body[56];
  put_stat56(body, 1, &st);
  frame(146, id, body, sizeof(body));
}
/* Check write permission through the same confined descriptor boundary, without any write.
 * A non-regular entry is refused before open; a swapped device opens nonblocking/no-ctty and
 * is refused before bytes, just as WRITE. No O_CREAT, O_TRUNC, ftruncate, write or fchmod. */
static void writable_request(uint32_t id, char *name) {
  const char *leaf;
  int parent = confined_parent(name, &leaf);
  if (parent < 0) { errno_frame(id, "parent", errno); return; }
  barrier("writer-parent-held");
  struct stat before, opened, named;
  if (metadata_stat_at(parent, leaf, &before, AT_SYMLINK_NOFOLLOW)) {
    int saved = errno; close(parent); errno_frame(id, "leaf", saved); return;
  }
  if (!S_ISREG(before.st_mode)) {
    close(parent); error_frame(id, S_ISLNK(before.st_mode) ? "leaf:ELOOP" : "leaf:ENOTREG"); return;
  }
  int file = confined_leaf_open(parent, leaf, O_WRONLY | O_NONBLOCK, 0);
  if (file < 0) { int saved = errno; close(parent); errno_frame(id, "leaf", saved); return; }
  barrier("writer-probe-opened");
  if (metadata_fstat(file, &opened) || metadata_stat_at(parent, leaf, &named, AT_SYMLINK_NOFOLLOW)) {
    int saved = errno; close(file); close(parent); errno_frame(id, "leaf", saved); return;
  }
  close(parent);
  if (!S_ISREG(opened.st_mode) || !S_ISREG(named.st_mode) ||
      !same_file(&before, &opened) || !same_file(&opened, &named)) {
    close(file); error_frame(id, "leaf:ESTALE"); return;
  }
  if (close(file)) { errno_frame(id, "close", errno); return; }
  unsigned char body[56];
  put_stat56(body, 1, &opened);
  frame(148, id, body, sizeof(body));
}
/* MKDIR, UNLINK and RMDIR act on the last component relative to its held folder. */
static void entry_request(unsigned char kind, uint32_t id, char *name) {
  const char *leaf;
  int parent = confined_parent(name, &leaf);
  if (parent < 0) { errno_frame(id, "parent", errno); return; }
  barrier("writer-parent-held");
  int failed = kind == 19 ? mkdirat(parent, leaf, 0777)
    : unlinkat(parent, leaf, kind == 22 ? AT_REMOVEDIR : 0);
  int saved = errno;
  close(parent);
  if (failed) errno_frame(id, "leaf", saved);
  else frame(147, id, NULL, 0);
}
static void rename_request(uint32_t id, const unsigned char *payload, uint32_t length) {
  char source[4097], destination[4097];
  if (length < 4) { error_frame(id, "rename-input"); return; }
  const uint32_t source_length = get32(payload);
  if (source_length > length - 4 || !writer_name(payload + 4, source_length, source) ||
      !writer_name(payload + 4 + source_length, length - 4 - source_length, destination)) {
    error_frame(id, "rename-input"); return;
  }
  const char *source_leaf, *destination_leaf;
  int from = confined_parent(source, &source_leaf);
  if (from < 0) { errno_frame(id, "parent", errno); return; }
  int to = confined_parent(destination, &destination_leaf);
  if (to < 0) { int saved = errno; close(from); errno_frame(id, "parent", saved); return; }
  barrier("writer-parent-held");
  int failed = renameat(from, source_leaf, to, destination_leaf);
  int saved = errno;
  close(from); close(to);
  if (failed) errno_frame(id, "leaf", saved);
  else frame(147, id, NULL, 0);
}
static int writer_main(const char *configured) {
  admit(configured);
  if (stopped) die("stopped");
#ifdef __linux__
  int probe = confined_open(".", 0);
  if (probe < 0) die("openat2-unavailable");
  close(probe);
#endif
  struct stat admitted;
  if (metadata_fstat(rootfd, &admitted) || !S_ISDIR(admitted.st_mode)) die("root-fstat");
  unsigned char identity[16];
  put64(identity, (uint64_t)admitted.st_dev); put64(identity + 8, (uint64_t)admitted.st_ino);
  frame(128, 0, identity, sizeof(identity));
  barrier("root-held");
  for (;;) {
    if (stopped) die("stopped");
    unsigned char header[16];
    int read_result = exact_read(0, header, sizeof(header));
    if (stopped) die("stopped");
    if (!read_result) break;
    if (read_result < 0 || memcmp(header, "B320", 4) || header[4] != 1 ||
        header[6] || header[7] || get32(header + 12) > WRITER_REQUEST_CAP) die("protocol");
    uint32_t id = get32(header + 8), length = get32(header + 12);
    unsigned char kind = header[5];
    if (!id || kind < 16 || kind > 23) die("protocol");
    unsigned char *payload = malloc((size_t)length + 1u);
    if (!payload) die("allocation");
    if (length && exact_read(0, payload, length) != 1) die("protocol-payload");
    payload[length] = 0;
    if (stopped) die("stopped");
    char name[4097];
    if (kind == 18) write_request(id, payload, length);
    else if (kind == 20) rename_request(id, payload, length);
    else if (kind == 17) {
      if (length < 5 || !get32(payload) || get32(payload) > WRITE_CAP ||
          !writer_name(payload + 4, length - 4, name)) error_frame(id, "read-input");
      else file_request(1, id, name, get32(payload), 145);
    } else if (!writer_name(payload, length, name)) error_frame(id, "relative-path");
    else if (kind == 16) lstat_request(id, name);
    else if (kind == 23) writable_request(id, name);
    else entry_request(kind, id, name);
    free(payload);
  }
  if (rootfd >= 0) close(rootfd);
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 3) die("usage");
  prepare_wakeup();
  struct sigaction action = {.sa_handler = on_stop};
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) die("signal");
  // BL-2006: the writer mode never runs Git, so it never admits one.
  if (!strcmp(argv[1], "--write-v2")) return writer_main(argv[2]);
  if (!strcmp(argv[1], "--write")) die("writer-version");
  struct sigaction child_action = {.sa_handler = on_child};
  sigemptyset(&child_action.sa_mask);
  if (sigaction(SIGCHLD, &child_action, NULL)) die("signal");
  admit(argv[1]);
  admit_git(argv[2]);
  prepare_git_environment();
  if (stopped) die("stopped");
#ifdef __linux__
  // An older kernel must refuse the helper before READY, not make every file
  // look merely absent or tempt a caller into a pathname-based fallback.
  int probe = confined_open(".", 0);
  if (probe < 0) die("openat2-unavailable");
  close(probe);
#endif
  struct stat admitted;
  if (metadata_fstat(rootfd, &admitted) || !S_ISDIR(admitted.st_mode)) die("root-fstat");
  unsigned char identity[16];
  put64(identity, (uint64_t)admitted.st_dev); put64(identity + 8, (uint64_t)admitted.st_ino);
  frame(128, 0, identity, sizeof(identity));
  barrier("root-held");
  for (;;) {
    if (stopped) die("stopped");
    unsigned char header[16];
    int read_result = exact_read(0, header, sizeof(header));
    if (stopped) die("stopped");
    if (!read_result) break;
    if (read_result < 0 || memcmp(header, "B320", 4) || header[4] != 1 ||
        header[6] || header[7] || get32(header + 12) > REQUEST_CAP) die("protocol");
    uint32_t id = get32(header + 8), length = get32(header + 12);
    if (!id || (header[5] != 1 && header[5] != 2 && header[5] != 3)) die("protocol");
    unsigned char payload[REQUEST_CAP + 1];
    if (exact_read(0, payload, length) != 1) die("protocol-payload");
    payload[length] = 0;
    if (stopped) die("stopped");
    if (header[5] == 3) git_request(id, payload, length);
    else if (header[5] == 1) {
      if (length < 5 || memchr(payload + 4, 0, length - 4) || !get32(payload) ||
          get32(payload) > FILE_CAP) error_frame(id, "read-input");
      else file_request(1, id, (char *)payload + 4, get32(payload), 129);
    } else if (!length || memchr(payload, 0, length)) error_frame(id, "relative-path");
    else file_request(2, id, (char *)payload, FILE_CAP, 130);
  }
  if (rootfd >= 0) close(rootfd);
  reap_git();
  free(git_executable);
  return 0;
}
