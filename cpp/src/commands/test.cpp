#include "test.hpp"
#include "../config.hpp"
#include "../glob.hpp"
#include "../process.hpp"
#include "../watcher.hpp"
#include <iostream>
#include <filesystem>

namespace fs = std::filesystem;

namespace ts0 {
namespace commands {

namespace {

int run_tests(const Config& config, const std::string& pattern) {
    // Find test files
    auto test_files = GlobMatcher::glob(pattern, config.project_root);

    if (test_files.empty()) {
        std::cout << "No test files found matching: " << pattern << "\n";
        return 0;
    }

    std::cout << "Running " << test_files.size() << " test file(s)...\n\n";

    std::vector<std::string> node_args;
    node_args.push_back("--experimental-strip-types");
    node_args.push_back("--test");

    for (const auto& file : test_files) {
        node_args.push_back(file.string());
    }

    return Process::spawn("node", node_args, config.project_root);
}

} // anonymous namespace

int test(const std::optional<std::string>& pattern, bool watch) {
    Config config = Config::load();

    std::string test_pattern = pattern.value_or(config.test.pattern);

    if (!watch) {
        return run_tests(config, test_pattern);
    }

    // Watch mode
    std::cout << "Watching for changes...\n";

    // Initial test run
    run_tests(config, test_pattern);

    // Set up file watcher
    FileWatcher watcher;
    watcher.watch_glob("**/*.ts", config.project_root, [&config, &test_pattern](const WatchEvent& event) {
        // Skip node_modules and dist
        std::string path_str = event.path.string();
        if (path_str.find("node_modules") != std::string::npos ||
            path_str.find("dist") != std::string::npos) {
            return;
        }

        std::cout << "\nFile changed: " << event.path.filename().string() << "\n";
        run_tests(config, test_pattern);
        std::cout << "\nWatching for changes...\n";
    });

    watcher.start();

    // Wait forever (until interrupted)
    while (watcher.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    return 0;
}

} // namespace commands
} // namespace ts0
