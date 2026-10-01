#include "test.hpp"
#include "../config.hpp"
#include "../glob.hpp"
#include "../process.hpp"
#include <filesystem>
#include <iostream>
#include <sstream>

namespace fs = std::filesystem;

namespace ts0::commands {

int cmd_test(const std::string& pattern, bool watch) {
    fs::path cwd = fs::current_path();
    Config config = load_config(cwd);

    std::string test_pattern = pattern.empty() ? config.test_pattern : pattern;

    // Find test files
    auto test_files = glob::find(cwd, test_pattern);

    if (test_files.empty()) {
        std::cerr << "No test files found matching: " << test_pattern << "\n";
        return 1;
    }

    std::cout << "Found " << test_files.size() << " test file(s)\n";

    // Build command for node test runner
    std::ostringstream cmd;
    cmd << "node --experimental-strip-types --test";

    if (watch) {
        cmd << " --watch";
    }

    for (const auto& file : test_files) {
        cmd << " " << file.string();
    }

    return run_interactive(cmd.str());
}

} // namespace ts0::commands
