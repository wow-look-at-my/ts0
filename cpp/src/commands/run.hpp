#pragma once

#include <string>
#include <optional>
#include <vector>

namespace ts0 {
namespace commands {

int run(
    const std::optional<std::string>& file = std::nullopt,
    bool no_build = false,
    const std::vector<std::string>& args = {}
);

} // namespace commands
} // namespace ts0
