#include "process.hpp"
#include <cstdlib>
#include <cstring>
#include <array>
#include <memory>
#include <sstream>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <unistd.h>
#include <sys/wait.h>
#include <fcntl.h>
#endif

namespace fs = std::filesystem;

namespace ts0 {

namespace {

// Resolve command, checking node_modules/.bin first
std::string resolve_command(const std::string& command, const std::optional<fs::path>& working_dir) {
    // If it's already an absolute path, use it directly
    if (fs::path(command).is_absolute()) {
        return command;
    }

#ifdef _WIN32
    std::string cmd_name = command;
    // Add .cmd extension for Windows if not present
    if (cmd_name.find('.') == std::string::npos) {
        cmd_name += ".cmd";
    }
#else
    const std::string& cmd_name = command;
#endif

    // Check node_modules/.bin in the working directory
    fs::path base = working_dir.value_or(fs::current_path());
    fs::path node_bin = base / "node_modules" / ".bin" / cmd_name;
    if (fs::exists(node_bin)) {
        return node_bin.string();
    }

    // Walk up directory tree looking for node_modules/.bin
    fs::path current = base;
    while (current.has_parent_path() && current != current.parent_path()) {
        node_bin = current / "node_modules" / ".bin" / cmd_name;
        if (fs::exists(node_bin)) {
            return node_bin.string();
        }
        current = current.parent_path();
    }

    // Fall back to original command
    return command;
}

} // anonymous namespace

#ifdef _WIN32

ProcessResult Process::run(
    const std::string& command,
    const std::vector<std::string>& args,
    const std::optional<fs::path>& working_dir,
    bool capture_output
) {
    ProcessResult result{0, "", ""};

    std::string resolved_cmd = resolve_command(command, working_dir);

    // Build command line
    std::string cmdline = "\"" + resolved_cmd + "\"";
    for (const auto& arg : args) {
        cmdline += " \"" + arg + "\"";
    }

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = NULL;

    HANDLE stdout_read = NULL, stdout_write = NULL;
    HANDLE stderr_read = NULL, stderr_write = NULL;

    if (capture_output) {
        CreatePipe(&stdout_read, &stdout_write, &sa, 0);
        SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
        CreatePipe(&stderr_read, &stderr_write, &sa, 0);
        SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);
    }

    STARTUPINFOA si = {};
    si.cb = sizeof(si);
    if (capture_output) {
        si.hStdOutput = stdout_write;
        si.hStdError = stderr_write;
        si.dwFlags |= STARTF_USESTDHANDLES;
    }

    PROCESS_INFORMATION pi = {};

    std::string work_dir_str;
    LPCSTR work_dir_ptr = NULL;
    if (working_dir.has_value()) {
        work_dir_str = working_dir->string();
        work_dir_ptr = work_dir_str.c_str();
    }

    if (!CreateProcessA(NULL, cmdline.data(), NULL, NULL, TRUE, 0, NULL, work_dir_ptr, &si, &pi)) {
        result.exit_code = -1;
        result.stderr_output = "Failed to create process";
        if (capture_output) {
            CloseHandle(stdout_read); CloseHandle(stdout_write);
            CloseHandle(stderr_read); CloseHandle(stderr_write);
        }
        return result;
    }

    if (capture_output) {
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);

        char buffer[4096];
        DWORD bytes_read;

        while (ReadFile(stdout_read, buffer, sizeof(buffer), &bytes_read, NULL) && bytes_read > 0) {
            result.stdout_output.append(buffer, bytes_read);
        }
        CloseHandle(stdout_read);

        while (ReadFile(stderr_read, buffer, sizeof(buffer), &bytes_read, NULL) && bytes_read > 0) {
            result.stderr_output.append(buffer, bytes_read);
        }
        CloseHandle(stderr_read);
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exit_code;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    result.exit_code = static_cast<int>(exit_code);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return result;
}

int Process::spawn(
    const std::string& command,
    const std::vector<std::string>& args,
    const std::optional<fs::path>& working_dir
) {
    std::string resolved_cmd = resolve_command(command, working_dir);

    std::string cmdline = "\"" + resolved_cmd + "\"";
    for (const auto& arg : args) {
        cmdline += " \"" + arg + "\"";
    }

    STARTUPINFOA si = {};
    si.cb = sizeof(si);

    PROCESS_INFORMATION pi = {};

    std::string work_dir_str;
    LPCSTR work_dir_ptr = NULL;
    if (working_dir.has_value()) {
        work_dir_str = working_dir->string();
        work_dir_ptr = work_dir_str.c_str();
    }

    if (!CreateProcessA(NULL, cmdline.data(), NULL, NULL, FALSE, 0, NULL, work_dir_ptr, &si, &pi)) {
        return -1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD exit_code;
    GetExitCodeProcess(pi.hProcess, &exit_code);

    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);

    return static_cast<int>(exit_code);
}

std::optional<std::string> Process::which(const std::string& command) {
    char buffer[MAX_PATH];
    if (SearchPathA(NULL, command.c_str(), ".exe", MAX_PATH, buffer, NULL)) {
        return std::string(buffer);
    }
    return std::nullopt;
}

#else // POSIX (Linux, macOS)

ProcessResult Process::run(
    const std::string& command,
    const std::vector<std::string>& args,
    const std::optional<fs::path>& working_dir,
    bool capture_output
) {
    ProcessResult result{0, "", ""};

    // Resolve command (check node_modules/.bin first)
    std::string resolved_cmd = resolve_command(command, working_dir);

    // Build the command line
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(resolved_cmd.c_str()));
    for (const auto& arg : args) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }
    argv.push_back(nullptr);

    int stdout_pipe[2] = {-1, -1};
    int stderr_pipe[2] = {-1, -1};

    if (capture_output) {
        if (pipe(stdout_pipe) == -1 || pipe(stderr_pipe) == -1) {
            result.exit_code = -1;
            result.stderr_output = "Failed to create pipes";
            return result;
        }
    }

    pid_t pid = fork();

    if (pid == -1) {
        result.exit_code = -1;
        result.stderr_output = "Failed to fork process";
        if (capture_output) {
            close(stdout_pipe[0]); close(stdout_pipe[1]);
            close(stderr_pipe[0]); close(stderr_pipe[1]);
        }
        return result;
    }

    if (pid == 0) {
        // Child process
        if (working_dir.has_value()) {
            if (chdir(working_dir->c_str()) != 0) {
                _exit(127);
            }
        }

        if (capture_output) {
            close(stdout_pipe[0]);
            close(stderr_pipe[0]);
            dup2(stdout_pipe[1], STDOUT_FILENO);
            dup2(stderr_pipe[1], STDERR_FILENO);
            close(stdout_pipe[1]);
            close(stderr_pipe[1]);
        }

        execvp(resolved_cmd.c_str(), argv.data());
        _exit(127);
    }

    // Parent process
    if (capture_output) {
        close(stdout_pipe[1]);
        close(stderr_pipe[1]);

        // Read output
        std::array<char, 4096> buffer;
        ssize_t bytes_read;

        while ((bytes_read = read(stdout_pipe[0], buffer.data(), buffer.size())) > 0) {
            result.stdout_output.append(buffer.data(), bytes_read);
        }
        close(stdout_pipe[0]);

        while ((bytes_read = read(stderr_pipe[0], buffer.data(), buffer.size())) > 0) {
            result.stderr_output.append(buffer.data(), bytes_read);
        }
        close(stderr_pipe[0]);
    }

    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status)) {
        result.exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        result.exit_code = 128 + WTERMSIG(status);
    } else {
        result.exit_code = -1;
    }

    return result;
}

int Process::spawn(
    const std::string& command,
    const std::vector<std::string>& args,
    const std::optional<fs::path>& working_dir
) {
    // Resolve command (check node_modules/.bin first)
    std::string resolved_cmd = resolve_command(command, working_dir);

    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(resolved_cmd.c_str()));
    for (const auto& arg : args) {
        argv.push_back(const_cast<char*>(arg.c_str()));
    }
    argv.push_back(nullptr);

    pid_t pid = fork();

    if (pid == -1) {
        return -1;
    }

    if (pid == 0) {
        // Child process
        if (working_dir.has_value()) {
            if (chdir(working_dir->c_str()) != 0) {
                _exit(127);
            }
        }

        execvp(resolved_cmd.c_str(), argv.data());
        _exit(127);
    }

    // Parent process - wait for child
    int status;
    waitpid(pid, &status, 0);

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }

    return -1;
}

std::optional<std::string> Process::which(const std::string& command) {
    // Check if it's an absolute path
    if (fs::exists(command)) {
        return command;
    }

    // Search in PATH
    const char* path_env = std::getenv("PATH");
    if (!path_env) {
        return std::nullopt;
    }

    std::string path_str(path_env);
    std::istringstream path_stream(path_str);
    std::string dir;

    while (std::getline(path_stream, dir, ':')) {
        fs::path candidate = fs::path(dir) / command;
        if (fs::exists(candidate) && access(candidate.c_str(), X_OK) == 0) {
            return candidate.string();
        }
    }

    return std::nullopt;
}

#endif

} // namespace ts0
