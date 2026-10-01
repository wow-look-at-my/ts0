#include "build.hpp"
#include "../config.hpp"
#include "../json.hpp"
#include "../process.hpp"
#include "../watcher.hpp"
#include <iostream>
#include <fstream>
#include <chrono>
#include <filesystem>

namespace fs = std::filesystem;

namespace ts0 {
namespace commands {

namespace {

std::string generate_tsconfig(const Config& config) {
    JsonObject compiler_options;
    compiler_options["target"] = "ES2022";
    compiler_options["module"] = "NodeNext";
    compiler_options["moduleResolution"] = "NodeNext";
    compiler_options["esModuleInterop"] = true;
    compiler_options["skipLibCheck"] = true;
    compiler_options["noEmit"] = true;

    if (config.strict) {
        compiler_options["strict"] = true;
    }

    JsonArray include;
    include.push_back(JsonValue("src/**/*.ts"));

    JsonObject tsconfig;
    tsconfig["compilerOptions"] = JsonValue(std::move(compiler_options));
    tsconfig["include"] = JsonValue(std::move(include));

    return JsonValue(std::move(tsconfig)).to_string(2);
}

BuildResult run_build(const Config& config) {
    BuildResult result;
    auto start_time = std::chrono::high_resolution_clock::now();

    std::string entry = config.get_entry();
    if (entry.empty()) {
        result.errors.push_back("No entry point found. Specify 'entry' in ts0.json or create src/main.ts");
        return result;
    }

    fs::path entry_path = config.project_root / entry;
    if (!fs::exists(entry_path)) {
        result.errors.push_back("Entry point not found: " + entry_path.string());
        return result;
    }

    // Generate temporary tsconfig for type checking
    fs::path tsconfig_path = config.project_root / ".ts0-tsconfig.json";
    {
        std::ofstream file(tsconfig_path);
        if (!file) {
            result.errors.push_back("Failed to create temporary tsconfig");
            return result;
        }
        file << generate_tsconfig(config);
    }

    // Run TypeScript type checking
    std::cout << "Type checking...\n";
    auto tsc_result = Process::run("tsc", {"--project", tsconfig_path.string()}, config.project_root);

    // Clean up temporary tsconfig
    fs::remove(tsconfig_path);

    if (tsc_result.exit_code != 0) {
        std::cerr << tsc_result.stdout_output;
        std::cerr << tsc_result.stderr_output;
        result.errors.push_back("Type checking failed");
        return result;
    }

    // Build with esbuild
    std::cout << "Bundling...\n";

    std::vector<std::string> esbuild_args;
    esbuild_args.push_back(entry_path.string());
    esbuild_args.push_back("--bundle");

    if (config.outfile.has_value()) {
        fs::path outfile = config.project_root / config.outfile.value();
        fs::create_directories(outfile.parent_path());
        esbuild_args.push_back("--outfile=" + outfile.string());
        result.output_files.push_back(outfile.string());
    } else {
        fs::path outdir = config.project_root / config.outdir;
        fs::create_directories(outdir);
        esbuild_args.push_back("--outdir=" + outdir.string());
        // Determine output file name
        fs::path entry_stem = fs::path(entry).stem();
        result.output_files.push_back((outdir / (entry_stem.string() + ".js")).string());
    }

    if (config.target == "node") {
        esbuild_args.push_back("--platform=node");
        // Add shebang for node executables
        if (config.outfile.has_value()) {
            esbuild_args.push_back("--banner:js=#!/usr/bin/env node");
        }
    } else {
        esbuild_args.push_back("--platform=browser");
    }

    if (config.format == "esm") {
        esbuild_args.push_back("--format=esm");
    } else {
        esbuild_args.push_back("--format=cjs");
    }

    if (config.minify) {
        esbuild_args.push_back("--minify");
    }

    if (config.sourcemap) {
        esbuild_args.push_back("--sourcemap");
    }

    auto esbuild_result = Process::run("esbuild", esbuild_args, config.project_root);

    if (esbuild_result.exit_code != 0) {
        std::cerr << esbuild_result.stdout_output;
        std::cerr << esbuild_result.stderr_output;
        result.errors.push_back("Build failed");
        return result;
    }

    // Make output executable if it's a node outfile
    if (config.target == "node" && config.outfile.has_value()) {
        fs::path outfile = config.project_root / config.outfile.value();
        fs::permissions(outfile, fs::perms::owner_exec | fs::perms::group_exec | fs::perms::others_exec, fs::perm_options::add);
    }

    auto end_time = std::chrono::high_resolution_clock::now();
    result.duration = std::chrono::duration<double, std::milli>(end_time - start_time).count();
    result.success = true;

    std::cout << "Build completed in " << static_cast<int>(result.duration) << "ms\n";
    for (const auto& file : result.output_files) {
        std::cout << "  -> " << file << "\n";
    }

    return result;
}

} // anonymous namespace

BuildResult build(bool watch) {
    Config config = Config::load();

    if (!watch) {
        return run_build(config);
    }

    // Watch mode
    std::cout << "Watching for changes...\n";

    // Initial build
    auto result = run_build(config);

    // Set up file watcher
    FileWatcher watcher;
    watcher.watch_glob("**/*.ts", config.project_root, [&config](const WatchEvent& event) {
        // Skip node_modules and dist
        std::string path_str = event.path.string();
        if (path_str.find("node_modules") != std::string::npos ||
            path_str.find("dist") != std::string::npos ||
            path_str.find(".ts0-") != std::string::npos) {
            return;
        }

        std::cout << "\nFile changed: " << event.path.filename().string() << "\n";
        run_build(config);
        std::cout << "\nWatching for changes...\n";
    });

    watcher.start();

    // Wait forever (until interrupted)
    while (watcher.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    return result;
}

} // namespace commands
} // namespace ts0
