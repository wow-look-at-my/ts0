#include "config.hpp"
#include <fstream>
#include <sstream>

namespace ts0 {

std::optional<fs::path> find_config_file(const fs::path& start_dir) {
    fs::path current = fs::absolute(start_dir);

    while (true) {
        fs::path config_path = current / "ts0.json";
        if (fs::exists(config_path)) {
            return config_path;
        }

        if (!current.has_parent_path() || current == current.parent_path()) {
            break;
        }
        current = current.parent_path();
    }

    return std::nullopt;
}

std::optional<std::string> auto_detect_entry(const fs::path& base_dir) {
    std::vector<std::string> candidates = {
        "src/main.ts", "src/index.ts", "main.ts", "index.ts"
    };

    for (const auto& candidate : candidates) {
        if (fs::exists(base_dir / candidate)) {
            return candidate;
        }
    }

    return std::nullopt;
}

Config load_config(const fs::path& dir) {
    Config config;

    auto config_path = find_config_file(dir);
    if (config_path) {
        std::ifstream file(*config_path);
        std::stringstream buffer;
        buffer << file.rdbuf();

        json::Value root = json::parse(buffer.str());

        if (auto v = root.get_string("entry")) config.entry = *v;
        if (auto v = root.get_string("outfile")) config.outfile = *v;
        if (auto v = root.get_string("outdir")) config.outdir = *v;
        if (auto v = root.get_string("target")) config.target = *v;
        if (auto v = root.get_string("format")) config.format = *v;
        if (auto v = root.get_bool("strict")) config.strict = *v;
        if (auto v = root.get_bool("minify")) config.minify = *v;
        if (auto v = root.get_bool("sourcemap")) config.sourcemap = *v;

        if (root["test"].is_object()) {
            if (auto v = root["test"].get_string("pattern")) {
                config.test_pattern = *v;
            }
        }

        if (root["esbuild"].is_object()) {
            config.esbuild = root["esbuild"].as_object();
        }
    }

    // Auto-detect entry if not specified
    if (!config.entry) {
        fs::path base = config_path ? config_path->parent_path() : dir;
        config.entry = auto_detect_entry(base);
    }

    return config;
}

} // namespace ts0
