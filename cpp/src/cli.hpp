#pragma once

#include <string>
#include <vector>
#include <optional>
#include <map>

namespace ts0 {

struct CliOptions {
    std::string command;
    std::vector<std::string> args;
    bool watch = false;
    bool no_build = false;
    bool force = false;
    bool help = false;
    std::optional<std::string> file;
    std::optional<std::string> pattern;
};

class Cli {
public:
    static CliOptions parse(int argc, char* argv[]);
    static void print_help();
    static int run(const CliOptions& options);
};

} // namespace ts0
