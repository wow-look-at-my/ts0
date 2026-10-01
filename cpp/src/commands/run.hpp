#pragma once
// Run command - execute TypeScript/JavaScript

#include <string>
#include <vector>

namespace ts0::commands {

int cmd_run(bool no_build, const std::string& file, const std::vector<std::string>& args);

} // namespace ts0::commands
