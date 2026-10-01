#include "run.hpp"
#include "build.hpp"
#include "../config.hpp"
#include "../process.hpp"
#include <iostream>
#include <filesystem>

namespace fs = std::filesystem;

namespace ts0 {
namespace commands {

int run(
    const std::optional<std::string>& file,
    bool no_build,
    const std::vector<std::string>& args
) {
    Config config = Config::load();

    // If a specific file is provided, run it directly with Node
    if (file.has_value()) {
        fs::path file_path = config.project_root / file.value();

        if (!fs::exists(file_path)) {
            std::cerr << "File not found: " << file_path.string() << "\n";
            return 1;
        }

        std::vector<std::string> node_args;

        // Use experimental-strip-types for .ts files
        if (file_path.extension() == ".ts") {
            node_args.push_back("--experimental-strip-types");
        }

        node_args.push_back(file_path.string());

        // Add user arguments
        for (const auto& arg : args) {
            node_args.push_back(arg);
        }

        return Process::spawn("node", node_args, config.project_root);
    }

    // Build first unless --no-build is specified
    if (!no_build) {
        auto result = build(false);
        if (!result.success) {
            return 1;
        }
    }

    // Determine what to run
    fs::path run_path;

    if (config.outfile.has_value()) {
        run_path = config.project_root / config.outfile.value();
    } else {
        std::string entry = config.get_entry();
        if (entry.empty()) {
            std::cerr << "No entry point found\n";
            return 1;
        }

        fs::path entry_stem = fs::path(entry).stem();
        run_path = config.project_root / config.outdir / (entry_stem.string() + ".js");
    }

    if (!fs::exists(run_path)) {
        std::cerr << "Output file not found: " << run_path.string() << "\n";
        std::cerr << "Run 'ts0 build' first.\n";
        return 1;
    }

    std::vector<std::string> node_args;
    node_args.push_back(run_path.string());

    // Add user arguments
    for (const auto& arg : args) {
        node_args.push_back(arg);
    }

    return Process::spawn("node", node_args, config.project_root);
}

} // namespace commands
} // namespace ts0
