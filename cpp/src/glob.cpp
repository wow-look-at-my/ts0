#include "glob.hpp"
#include <algorithm>

namespace fs = std::filesystem;

namespace ts0 {

std::string GlobMatcher::glob_to_regex(const std::string& pattern) {
    std::string result;
    result.reserve(pattern.size() * 2);

    size_t i = 0;
    while (i < pattern.size()) {
        char c = pattern[i];

        if (c == '*') {
            if (i + 1 < pattern.size() && pattern[i + 1] == '*') {
                // ** matches any number of path segments
                if (i + 2 < pattern.size() && pattern[i + 2] == '/') {
                    result += "(?:[^/]*/)*";
                    i += 3;
                } else {
                    result += ".*";
                    i += 2;
                }
            } else {
                // * matches anything except /
                result += "[^/]*";
                ++i;
            }
        } else if (c == '?') {
            result += "[^/]";
            ++i;
        } else if (c == '[') {
            // Character class
            size_t end = pattern.find(']', i + 1);
            if (end != std::string::npos) {
                result += pattern.substr(i, end - i + 1);
                i = end + 1;
            } else {
                result += "\\[";
                ++i;
            }
        } else if (c == '{') {
            // Brace expansion {a,b,c}
            size_t end = pattern.find('}', i + 1);
            if (end != std::string::npos) {
                result += "(?:";
                std::string alternatives = pattern.substr(i + 1, end - i - 1);
                size_t pos = 0;
                size_t comma;
                bool first = true;
                while ((comma = alternatives.find(',', pos)) != std::string::npos) {
                    if (!first) result += "|";
                    result += glob_to_regex(alternatives.substr(pos, comma - pos));
                    pos = comma + 1;
                    first = false;
                }
                if (!first) result += "|";
                result += glob_to_regex(alternatives.substr(pos));
                result += ")";
                i = end + 1;
            } else {
                result += "\\{";
                ++i;
            }
        } else if (c == '.' || c == '(' || c == ')' || c == '+' ||
                   c == '|' || c == '^' || c == '$' || c == '\\') {
            result += '\\';
            result += c;
            ++i;
        } else {
            result += c;
            ++i;
        }
    }

    return result;
}

GlobMatcher::GlobMatcher(const std::string& pattern)
    : pattern_(pattern)
    , regex_(glob_to_regex(pattern), std::regex::ECMAScript | std::regex::optimize)
{
}

bool GlobMatcher::matches(const std::string& path) const {
    return std::regex_match(path, regex_);
}

bool GlobMatcher::matches(const fs::path& path) const {
    return matches(path.string());
}

std::vector<fs::path> GlobMatcher::glob(const std::string& pattern, const fs::path& base_dir) {
    std::vector<fs::path> results;
    GlobMatcher matcher(pattern);

    std::error_code ec;
    for (const auto& entry : fs::recursive_directory_iterator(base_dir, fs::directory_options::skip_permission_denied, ec)) {
        if (!entry.is_regular_file()) continue;

        fs::path relative = fs::relative(entry.path(), base_dir, ec);
        if (ec) continue;

        std::string rel_str = relative.string();
        // Normalize path separators
        std::replace(rel_str.begin(), rel_str.end(), '\\', '/');

        if (matcher.matches(rel_str)) {
            results.push_back(entry.path());
        }
    }

    std::sort(results.begin(), results.end());
    return results;
}

} // namespace ts0
