#include "init.hpp"
#include "../config.hpp"
#include "../json.hpp"
#include <iostream>
#include <fstream>
#include <filesystem>

namespace fs = std::filesystem;

namespace ts0 {
namespace commands {

int init(bool force) {
    fs::path config_path = fs::current_path() / "ts0.json";

    if (fs::exists(config_path) && !force) {
        std::cerr << "ts0.json already exists. Use --force to overwrite.\n";
        return 1;
    }

    // Create default config
    JsonObject config;
    config["entry"] = "src/main.ts";
    config["outfile"] = "dist/main";
    config["target"] = "node";
    config["format"] = "esm";
    config["strict"] = true;

    // Write ts0.json
    {
        std::ofstream file(config_path);
        if (!file) {
            std::cerr << "Failed to create ts0.json\n";
            return 1;
        }
        file << JsonValue(std::move(config)).to_string(2) << "\n";
    }
    std::cout << "Created ts0.json\n";

    // Create src directory
    fs::path src_dir = fs::current_path() / "src";
    if (!fs::exists(src_dir)) {
        fs::create_directories(src_dir);
        std::cout << "Created src/\n";
    }

    // Create sample main.ts
    fs::path main_path = src_dir / "main.ts";
    if (!fs::exists(main_path) || force) {
        std::ofstream file(main_path);
        if (!file) {
            std::cerr << "Failed to create src/main.ts\n";
            return 1;
        }
        file << R"(// Entry point for your application

function greet(name: string): string {
	return `Hello, ${name}!`;
}

console.log(greet("World"));
)";
        std::cout << "Created src/main.ts\n";
    }

    // Create sample test file
    fs::path test_path = src_dir / "main.test.ts";
    if (!fs::exists(test_path) || force) {
        std::ofstream file(test_path);
        if (!file) {
            std::cerr << "Failed to create src/main.test.ts\n";
            return 1;
        }
        file << R"(import { test } from "node:test";
import assert from "node:assert";

test("example test", () => {
	assert.strictEqual(1 + 1, 2);
});
)";
        std::cout << "Created src/main.test.ts\n";
    }

    std::cout << "\nProject initialized! Run 'ts0 build' to build.\n";
    return 0;
}

} // namespace commands
} // namespace ts0
