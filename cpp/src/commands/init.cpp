#include "init.hpp"
#include "../json.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>

namespace fs = std::filesystem;

namespace ts0::commands {

int init(bool force) {
    fs::path cwd = fs::current_path();
    fs::path config_path = cwd / "ts0.json";
    fs::path src_dir = cwd / "src";
    fs::path main_path = src_dir / "main.ts";
    fs::path test_path = src_dir / "main.test.ts";

    // Check if files exist
    if (!force && fs::exists(config_path)) {
        std::cerr << "ts0.json already exists. Use --force to overwrite.\n";
        return 1;
    }

    // Create ts0.json
    json::Object test_obj;
    test_obj["pattern"] = "**/*.test.ts";

    json::Object config;
    config["entry"] = "src/main.ts";
    config["outdir"] = "dist";
    config["target"] = "node";
    config["format"] = "esm";
    config["strict"] = true;
    config["test"] = json::Value(std::move(test_obj));

    {
        std::ofstream f(config_path);
        f << json::stringify(json::Value(config));
    }
    std::cout << "Created ts0.json\n";

    // Create src directory
    fs::create_directories(src_dir);

    // Create main.ts
    if (!fs::exists(main_path) || force) {
        std::ofstream f(main_path);
        f << R"(// Main entry point
console.log("Hello from ts0!");

export function greet(name: string): string {
    return `Hello, ${name}!`;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log(greet("World"));
}
)";
        std::cout << "Created src/main.ts\n";
    }

    // Create test file
    if (!fs::exists(test_path) || force) {
        std::ofstream f(test_path);
        f << R"(import { test } from "node:test";
import { strict as assert } from "node:assert";
import { greet } from "./main.ts";

test("greet returns greeting message", () => {
    assert.equal(greet("World"), "Hello, World!");
});

test("greet handles different names", () => {
    assert.equal(greet("TypeScript"), "Hello, TypeScript!");
});
)";
        std::cout << "Created src/main.test.ts\n";
    }

    std::cout << "\nProject initialized! Next steps:\n";
    std::cout << "  ts0 build    Build the project\n";
    std::cout << "  ts0 run      Run the application\n";
    std::cout << "  ts0 test     Run tests\n";

    return 0;
}

} // namespace ts0::commands
