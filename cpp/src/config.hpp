#pragma once
// Configuration loading and management

#include "json.hpp"
#include <filesystem>
#include <optional>
#include <string>

namespace fs = std::filesystem;

namespace ts0 {

struct Config {
    std::optional<std::string> entry;
    std::optional<std::string> outfile;
    std::string outdir = "dist";
    std::string target = "node";
    std::string format = "esm";
    bool strict = true;
    bool minify = false;
    bool sourcemap = true;
    std::string test_pattern = "**/*.test.ts";
    json::Object esbuild;
};

// Find ts0.json by walking up directory tree
std::optional<fs::path> find_config_file(const fs::path& start_dir);

// Auto-detect entry point from common locations
std::optional<std::string> auto_detect_entry(const fs::path& base_dir);

// Load and merge configuration with defaults
Config load_config(const fs::path& dir);

} // namespace ts0
