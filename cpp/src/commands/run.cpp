#include "run.hpp"
#include "build.hpp"
#include "../config.hpp"
#include "../process.hpp"
#include <filesystem>
#include <iostream>
#include <sstream>

namespace fs = std::filesystem;

namespace ts0::commands {

int cmd_run(bool no_build, const std::string& file, const std::vector<std::string>& args) {
    fs::path cwd = fs::current_path();
    Config config = load_config(cwd);

    std::string target_file;

    if (!file.empty()) {
        target_file = file;
    } else if (no_build) {
        // Use entry file directly with --experimental-strip-types
        if (!config.entry) {
            std::cerr << "No entry point found\n";
            return 1;
        }
        target_file = *config.entry;
    } else {
        // Build first, then run output
        std::cout << "Building...\n";
        auto tc_result = typecheck(config, cwd);
        if (!tc_result.success) {
            std::cerr << "Type errors found:\n";
            for (const auto& err : tc_result.errors) {
                std::cerr << err << "\n";
            }
            return 1;
        }

        auto build_result = build(config, cwd);
        if (!build_result.success) {
            std::cerr << "Build failed:\n";
            for (const auto& err : build_result.errors) {
                std::cerr << err << "\n";
            }
            return 1;
        }

        if (build_result.output_files.empty()) {
            std::cerr << "No output files generated\n";
            return 1;
        }

        target_file = build_result.output_files[0];
    }

    // Build command
    std::ostringstream cmd;

    if (target_file.ends_with(".ts")) {
        cmd << "node --experimental-strip-types " << target_file;
    } else {
        cmd << "node " << target_file;
    }

    for (const auto& arg : args) {
        cmd << " " << arg;
    }

    return run_interactive(cmd.str());
}

} // namespace ts0::commands
