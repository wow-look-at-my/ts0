#pragma once

#include <string>
#include <vector>
#include <optional>
#include <filesystem>

namespace ts0 {

struct ProcessResult {
    int exit_code;
    std::string stdout_output;
    std::string stderr_output;
};

class Process {
public:
    static ProcessResult run(
        const std::string& command,
        const std::vector<std::string>& args = {},
        const std::optional<std::filesystem::path>& working_dir = std::nullopt,
        bool capture_output = true
    );

    static int spawn(
        const std::string& command,
        const std::vector<std::string>& args = {},
        const std::optional<std::filesystem::path>& working_dir = std::nullopt
    );

    static std::optional<std::string> which(const std::string& command);
};

} // namespace ts0
