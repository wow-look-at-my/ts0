#pragma once

#include <string>
#include <optional>

namespace ts0 {
namespace commands {

int test(
    const std::optional<std::string>& pattern = std::nullopt,
    bool watch = false
);

} // namespace commands
} // namespace ts0
