#include "process.hpp"
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include <unistd.h>
#include <sys/wait.h>

namespace ts0 {

ProcessResult run_command(const std::string& cmd) {
    ProcessResult result;
    result.exit_code = 0;

    // Create temp files for output capture
    std::string stdout_file = "/tmp/ts0_stdout_" + std::to_string(getpid());
    std::string stderr_file = "/tmp/ts0_stderr_" + std::to_string(getpid());

    std::string full_cmd = cmd + " >" + stdout_file + " 2>" + stderr_file;
    result.exit_code = std::system(full_cmd.c_str());
    result.exit_code = WEXITSTATUS(result.exit_code);

    // Read outputs
    if (std::ifstream f(stdout_file); f) {
        std::stringstream ss;
        ss << f.rdbuf();
        result.stdout_output = ss.str();
    }
    if (std::ifstream f(stderr_file); f) {
        std::stringstream ss;
        ss << f.rdbuf();
        result.stderr_output = ss.str();
    }

    // Cleanup
    std::remove(stdout_file.c_str());
    std::remove(stderr_file.c_str());

    return result;
}

int run_interactive(const std::string& cmd) {
    return WEXITSTATUS(std::system(cmd.c_str()));
}

} // namespace ts0
