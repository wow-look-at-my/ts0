#pragma once
// Test command - run tests with Node.js test runner

#include <string>

namespace ts0::commands {

int cmd_test(const std::string& pattern, bool watch);

} // namespace ts0::commands
