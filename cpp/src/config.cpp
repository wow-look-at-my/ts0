#include "config.hpp"
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;

namespace ts0 {

std::optional<fs::path> find_config_file(const fs::path& start_dir) {
    fs::path current = fs::absolute(start_dir);

    while (true) {
        fs::path config_path = current / "ts0.json";
        if (fs::exists(config_path)) {
            return config_path;
        }

        if (!current.has_parent_path() || current.parent_path() == current) {
            break;
        }
        current = current.parent_path();
    }

    return std::nullopt;
}

Config Config::defaults() {
    Config config;
    config.project_root = fs::current_path();
    return config;
}

Config Config::from_json(const JsonValue& json, const fs::path& config_file) {
    Config config = defaults();
    config.config_path = config_file;
    config.project_root = config_file.parent_path();

    if (json.contains("entry") && json["entry"].is_string()) {
        config.entry = json["entry"].as_string();
    }
    if (json.contains("outfile") && json["outfile"].is_string()) {
        config.outfile = json["outfile"].as_string();
    }
    if (json.contains("outdir") && json["outdir"].is_string()) {
        config.outdir = json["outdir"].as_string();
    }
    if (json.contains("target") && json["target"].is_string()) {
        config.target = json["target"].as_string();
    }
    if (json.contains("format") && json["format"].is_string()) {
        config.format = json["format"].as_string();
    }
    if (json.contains("strict") && json["strict"].is_bool()) {
        config.strict = json["strict"].as_bool();
    }
    if (json.contains("minify") && json["minify"].is_bool()) {
        config.minify = json["minify"].as_bool();
    }
    if (json.contains("sourcemap") && json["sourcemap"].is_bool()) {
        config.sourcemap = json["sourcemap"].as_bool();
    }
    if (json.contains("test") && json["test"].is_object()) {
        const auto& test_obj = json["test"];
        if (test_obj.contains("pattern") && test_obj["pattern"].is_string()) {
            config.test.pattern = test_obj["pattern"].as_string();
        }
    }
    if (json.contains("esbuild") && json["esbuild"].is_object()) {
        config.esbuild = json["esbuild"];
    }

    return config;
}

Config Config::load(const std::optional<fs::path>& path) {
    fs::path config_file;

    if (path.has_value()) {
        config_file = path.value();
    } else {
        auto found = find_config_file();
        if (!found.has_value()) {
            return defaults();
        }
        config_file = found.value();
    }

    std::ifstream file(config_file);
    if (!file) {
        return defaults();
    }

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string content = buffer.str();

    try {
        JsonValue json = JsonValue::parse(content);
        return from_json(json, config_file);
    } catch (const JsonParseError& e) {
        throw std::runtime_error("Failed to parse " + config_file.string() + ": " + e.what());
    }
}

std::string Config::detect_entry() const {
    const std::vector<std::string> candidates = {
        "src/main.ts",
        "src/index.ts",
        "main.ts",
        "index.ts"
    };

    for (const auto& candidate : candidates) {
        fs::path entry_path = project_root / candidate;
        if (fs::exists(entry_path)) {
            return candidate;
        }
    }

    return "";
}

std::string Config::get_entry() const {
    if (entry.has_value()) {
        return entry.value();
    }
    return detect_entry();
}

JsonValue Config::to_json() const {
    JsonObject obj;

    if (entry.has_value()) {
        obj["entry"] = entry.value();
    }
    if (outfile.has_value()) {
        obj["outfile"] = outfile.value();
    }
    obj["outdir"] = outdir;
    obj["target"] = target;
    obj["format"] = format;
    obj["strict"] = strict;
    obj["minify"] = minify;
    obj["sourcemap"] = sourcemap;

    JsonObject test_obj;
    test_obj["pattern"] = test.pattern;
    obj["test"] = JsonValue(std::move(test_obj));

    if (!esbuild.is_null()) {
        obj["esbuild"] = esbuild;
    }

    return JsonValue(std::move(obj));
}

} // namespace ts0
