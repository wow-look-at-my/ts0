#pragma once
// Build command - type checking and bundling

#include "../config.hpp"
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace ts0::commands {

struct BuildResult {
    bool success;
    std::vector<std::string> output_files;
    std::vector<std::string> errors;
    long duration_ms;
};

struct TypeCheckResult {
    bool success;
    std::vector<std::string> errors;
};

// Run TypeScript type checking
TypeCheckResult typecheck(const Config& config, const fs::path& base_dir);

// Build the project with esbuild
BuildResult build(const Config& config, const fs::path& base_dir, bool watch = false);

// CLI handler
int cmd_build(bool watch);

} // namespace ts0::commands
