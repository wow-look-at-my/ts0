#pragma once

#include <string>
#include <optional>
#include <filesystem>
#include "json.hpp"

namespace ts0 {

struct TestConfig {
    std::string pattern = "**/*.test.ts";
};

struct Config {
    std::optional<std::string> entry;
    std::optional<std::string> outfile;
    std::string outdir = "dist";
    std::string target = "node";
    std::string format = "esm";
    bool strict = true;
    bool minify = false;
    bool sourcemap = false;
    TestConfig test;
    JsonValue esbuild;

    // Runtime info
    std::filesystem::path config_path;
    std::filesystem::path project_root;

    static Config load(const std::optional<std::filesystem::path>& path = std::nullopt);
    static Config from_json(const JsonValue& json, const std::filesystem::path& config_file);
    static Config defaults();

    JsonValue to_json() const;
    std::string detect_entry() const;
    std::string get_entry() const;
};

std::optional<std::filesystem::path> find_config_file(const std::filesystem::path& start_dir = std::filesystem::current_path());

} // namespace ts0
