#pragma once
// Process execution utilities

#include <string>

namespace ts0 {

struct ProcessResult {
    int exit_code;
    std::string stdout_output;
    std::string stderr_output;
};

// Run command and capture output
ProcessResult run_command(const std::string& cmd);

// Run command with inherited stdio (interactive)
int run_interactive(const std::string& cmd);

} // namespace ts0
