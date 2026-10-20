#include "build.hpp"
#include "../process.hpp"
#include "../json.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>

namespace ts0::commands {

TypeCheckResult typecheck(const Config& config, const fs::path& base_dir) {
    TypeCheckResult result;
    result.success = true;

    // Generate temporary tsconfig
    json::Object compiler_options;
    compiler_options["target"] = "ESNext";
    compiler_options["module"] = "ESNext";
    compiler_options["moduleResolution"] = "bundler";
    compiler_options["esModuleInterop"] = true;
    compiler_options["strict"] = config.strict;
    compiler_options["skipLibCheck"] = true;
    compiler_options["noEmit"] = true;
    compiler_options["resolveJsonModule"] = true;

    json::Array include;
    include.push_back("src/**/*.ts");
    if (config.entry && config.entry->find("src/") != 0) {
        include.push_back(*config.entry);
    }

    json::Object tsconfig;
    tsconfig["compilerOptions"] = json::Value(std::move(compiler_options));
    tsconfig["include"] = json::Value(std::move(include));

    fs::path tsconfig_path = base_dir / ".ts0-tsconfig.json";
    {
        std::ofstream f(tsconfig_path);
        f << json::stringify(json::Value(tsconfig));
    }

    // Run tsc
    std::string cmd = "npx tsc --project " + tsconfig_path.string();
    auto proc_result = run_command(cmd);

    // Cleanup
    fs::remove(tsconfig_path);

    if (proc_result.exit_code != 0) {
        result.success = false;
        if (!proc_result.stdout_output.empty()) {
            result.errors.push_back(proc_result.stdout_output);
        }
        if (!proc_result.stderr_output.empty()) {
            result.errors.push_back(proc_result.stderr_output);
        }
    }

    return result;
}

BuildResult build(const Config& config, const fs::path& base_dir, bool watch) {
    BuildResult result;
    result.success = true;

    auto start = std::chrono::steady_clock::now();

    if (!config.entry) {
        result.success = false;
        result.errors.push_back("No entry point found. Create src/main.ts or specify 'entry' in ts0.json");
        return result;
    }

    fs::path entry_path = base_dir / *config.entry;
    if (!fs::exists(entry_path)) {
        result.success = false;
        result.errors.push_back("Entry file not found: " + entry_path.string());
        return result;
    }

    // Determine output path
    std::string outpath;
    if (config.outfile) {
        outpath = (base_dir / *config.outfile).string();
    } else {
        fs::path outdir = base_dir / config.outdir;
        fs::create_directories(outdir);
        std::string basename = entry_path.stem().string();
        outpath = (outdir / (basename + ".js")).string();
    }

    // Build esbuild command
    std::ostringstream cmd;
    cmd << "npx esbuild " << entry_path.string();
    cmd << " --bundle";
    cmd << " --platform=" << config.target;
    cmd << " --format=" << config.format;
    cmd << " --target=esnext";

    if (config.outfile) {
        cmd << " --outfile=" << outpath;
    } else {
        cmd << " --outdir=" << (base_dir / config.outdir).string();
    }

    if (config.minify) cmd << " --minify";
    if (config.sourcemap) cmd << " --sourcemap";

    // For node target, don't bundle node_modules
    if (config.target == "node") {
        cmd << " --packages=external";
    }

    if (watch) {
        cmd << " --watch";
    }

    auto proc_result = run_command(cmd.str());

    if (proc_result.exit_code != 0) {
        result.success = false;
        if (!proc_result.stdout_output.empty()) {
            result.errors.push_back(proc_result.stdout_output);
        }
        if (!proc_result.stderr_output.empty()) {
            result.errors.push_back(proc_result.stderr_output);
        }
    } else {
        // Add shebang for CLI applications
        if (config.outfile && config.target == "node") {
            std::string content;
            {
                std::ifstream f(outpath);
                std::stringstream ss;
                ss << f.rdbuf();
                content = ss.str();
            }

            if (content.find("#!") != 0) {
                std::ofstream f(outpath);
                f << "#!/usr/bin/env node\n" << content;
            }

            // Make executable
            fs::permissions(outpath,
                fs::perms::owner_exec | fs::perms::group_exec | fs::perms::others_exec,
                fs::perm_options::add);
        }

        result.output_files.push_back(outpath);
    }

    auto end = std::chrono::steady_clock::now();
    result.duration_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

    return result;
}

int cmd_build(bool watch) {
    fs::path cwd = fs::current_path();
    Config config = load_config(cwd);

    std::cout << "Type checking...\n";
    auto tc_result = typecheck(config, cwd);

    if (!tc_result.success) {
        std::cerr << "Type errors found:\n";
        for (const auto& err : tc_result.errors) {
            std::cerr << err << "\n";
        }
        return 1;
    }
    std::cout << "Type check passed\n";

    std::cout << "Building...\n";
    auto build_result = build(config, cwd, watch);

    if (!build_result.success) {
        std::cerr << "Build failed:\n";
        for (const auto& err : build_result.errors) {
            std::cerr << err << "\n";
        }
        return 1;
    }

    std::cout << "Build complete in " << build_result.duration_ms << "ms\n";
    for (const auto& file : build_result.output_files) {
        std::cout << "  " << file << "\n";
    }

    return 0;
}

} // namespace ts0::commands
