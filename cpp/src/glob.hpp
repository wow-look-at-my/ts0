#pragma once

#include <string>
#include <vector>
#include <filesystem>
#include <regex>

namespace ts0 {

class GlobMatcher {
public:
    explicit GlobMatcher(const std::string& pattern);

    bool matches(const std::string& path) const;
    bool matches(const std::filesystem::path& path) const;

    static std::vector<std::filesystem::path> glob(
        const std::string& pattern,
        const std::filesystem::path& base_dir = std::filesystem::current_path()
    );

private:
    std::string pattern_;
    std::regex regex_;

    static std::string glob_to_regex(const std::string& pattern);
};

} // namespace ts0
