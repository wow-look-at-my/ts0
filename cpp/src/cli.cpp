#include "cli.hpp"
#include "config.hpp"
#include "commands/init.hpp"
#include "commands/build.hpp"
#include "commands/run.hpp"
#include "commands/test.hpp"
#include <iostream>
#include <algorithm>

namespace ts0 {

CliOptions Cli::parse(int argc, char* argv[]) {
    CliOptions options;
    std::vector<std::string> positional;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "--help" || arg == "-h") {
            options.help = true;
        } else if (arg == "--watch" || arg == "-w") {
            options.watch = true;
        } else if (arg == "--no-build") {
            options.no_build = true;
        } else if (arg == "--force") {
            options.force = true;
        } else if (arg.starts_with("-")) {
            // Unknown flag - might be passed to the run command
            options.args.push_back(arg);
        } else {
            positional.push_back(arg);
        }
    }

    // First positional is the command
    if (!positional.empty()) {
        options.command = positional[0];
        positional.erase(positional.begin());
    }

    // Handle remaining positional arguments based on command
    if (options.command == "run") {
        if (!positional.empty()) {
            options.file = positional[0];
            positional.erase(positional.begin());
        }
        // Rest are arguments to pass to the script
        for (const auto& p : positional) {
            options.args.push_back(p);
        }
    } else if (options.command == "test") {
        if (!positional.empty()) {
            options.pattern = positional[0];
        }
    }

    return options;
}

void Cli::print_help() {
    std::cout << R"(ts0 - Simple TypeScript framework

Usage:
  ts0 <command> [options]

Commands:
  init              Create ts0.json and sample files
  build             Type-check and build the project
  run [file]        Build and run (or run specific file)
  test [pattern]    Run tests

Options:
  --watch, -w       Watch mode (build, test)
  --no-build        Skip build step (run)
  --force           Overwrite existing files (init)
  --help, -h        Show this help

Examples:
  ts0 init                          # Initialize a new project
  ts0 build                         # Type-check and build
  ts0 run                           # Build and run entry point
  ts0 run src/app.ts                # Run specific file
  ts0 run --no-build                # Run without building (fast dev)
  ts0 test                          # Run all tests
  ts0 test --watch                  # Run tests in watch mode
)";
}

int Cli::run(const CliOptions& options) {
    if (options.help || options.command.empty()) {
        print_help();
        return options.help ? 0 : 1;
    }

    try {
        if (options.command == "init") {
            return commands::init(options.force);
        } else if (options.command == "build") {
            auto result = commands::build(options.watch);
            return result.success ? 0 : 1;
        } else if (options.command == "run") {
            return commands::run(options.file, options.no_build, options.args);
        } else if (options.command == "test") {
            return commands::test(options.pattern, options.watch);
        } else {
            std::cerr << "Unknown command: " << options.command << "\n";
            std::cerr << "Run 'ts0 --help' for usage information.\n";
            return 1;
        }
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
}

} // namespace ts0
