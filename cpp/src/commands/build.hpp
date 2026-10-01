#pragma once

#include <string>
#include <vector>

namespace ts0 {
namespace commands {

struct BuildResult {
    bool success = false;
    std::vector<std::string> output_files;
    std::vector<std::string> errors;
    double duration = 0.0; // milliseconds
};

BuildResult build(bool watch = false);

} // namespace commands
} // namespace ts0
