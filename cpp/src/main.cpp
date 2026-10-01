// ts0 - Simple TypeScript framework with good defaults
// C++20 port

#include "commands/init.hpp"
#include "commands/build.hpp"
#include "commands/run.hpp"
#include "commands/test.hpp"
#include <iostream>
#include <string>
#include <vector>

void print_help() {
    std::cout << R"(ts0 - Simple TypeScript framework with good defaults

Usage: ts0 <command> [options]

Commands:
  init          Initialize a new ts0 project
  build         Build the project
  run [file]    Run the application
  test          Run tests

Options:
  -h, --help    Show this help message
  -w, --watch   Watch mode (build, test)
  --no-build    Skip build step (run)
  --force       Overwrite existing files (init)

Examples:
  ts0 init              Create a new project
  ts0 build             Build the project
  ts0 build --watch     Build and watch for changes
  ts0 run               Build and run
  ts0 run --no-build    Run without building (uses --experimental-strip-types)
  ts0 test              Run all tests
  ts0 test --watch      Run tests in watch mode
)";
}

int main(int argc, char* argv[]) {
    std::vector<std::string> args(argv + 1, argv + argc);

    if (args.empty()) {
        print_help();
        return 0;
    }

    // Parse flags
    bool watch = false;
    bool no_build = false;
    bool force = false;
    bool help = false;
    std::string command;
    std::vector<std::string> positional;

    for (size_t i = 0; i < args.size(); ++i) {
        const auto& arg = args[i];

        if (arg == "-h" || arg == "--help") {
            help = true;
        } else if (arg == "-w" || arg == "--watch") {
            watch = true;
        } else if (arg == "--no-build") {
            no_build = true;
        } else if (arg == "--force") {
            force = true;
        } else if (arg[0] != '-') {
            if (command.empty()) {
                command = arg;
            } else {
                positional.push_back(arg);
            }
        }
    }

    if (help || command == "help") {
        print_help();
        return 0;
    }

    // Dispatch commands
    if (command == "init") {
        return ts0::commands::init(force);
    } else if (command == "build") {
        return ts0::commands::cmd_build(watch);
    } else if (command == "run") {
        std::string file = positional.empty() ? "" : positional[0];
        std::vector<std::string> run_args(
            positional.begin() + (file.empty() ? 0 : 1),
            positional.end()
        );
        return ts0::commands::cmd_run(no_build, file, run_args);
    } else if (command == "test") {
        std::string pattern = positional.empty() ? "" : positional[0];
        return ts0::commands::cmd_test(pattern, watch);
    } else {
        std::cerr << "Unknown command: " << command << "\n";
        std::cerr << "Run 'ts0 --help' for usage\n";
        return 1;
    }
}
