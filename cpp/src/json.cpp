#include "json.hpp"
#include <sstream>
#include <cctype>
#include <charconv>

namespace ts0 {

namespace {

class JsonParser {
public:
    explicit JsonParser(std::string_view json) : json_(json), pos_(0) {}

    JsonValue parse() {
        skip_whitespace();
        auto value = parse_value();
        skip_whitespace();
        if (pos_ < json_.size()) {
            throw JsonParseError("Unexpected content after JSON value");
        }
        return value;
    }

private:
    std::string_view json_;
    size_t pos_;

    char peek() const {
        return pos_ < json_.size() ? json_[pos_] : '\0';
    }

    char consume() {
        return pos_ < json_.size() ? json_[pos_++] : '\0';
    }

    void skip_whitespace() {
        while (pos_ < json_.size() && std::isspace(json_[pos_])) {
            ++pos_;
        }
    }

    void expect(char c) {
        if (consume() != c) {
            throw JsonParseError(std::string("Expected '") + c + "'");
        }
    }

    JsonValue parse_value() {
        skip_whitespace();
        char c = peek();

        if (c == 'n') return parse_null();
        if (c == 't' || c == 'f') return parse_bool();
        if (c == '"') return parse_string();
        if (c == '[') return parse_array();
        if (c == '{') return parse_object();
        if (c == '-' || std::isdigit(c)) return parse_number();

        throw JsonParseError(std::string("Unexpected character: ") + c);
    }

    JsonValue parse_null() {
        if (json_.substr(pos_, 4) == "null") {
            pos_ += 4;
            return JsonValue(nullptr);
        }
        throw JsonParseError("Invalid null literal");
    }

    JsonValue parse_bool() {
        if (json_.substr(pos_, 4) == "true") {
            pos_ += 4;
            return JsonValue(true);
        }
        if (json_.substr(pos_, 5) == "false") {
            pos_ += 5;
            return JsonValue(false);
        }
        throw JsonParseError("Invalid boolean literal");
    }

    JsonValue parse_string() {
        expect('"');
        std::string result;
        while (peek() != '"') {
            if (pos_ >= json_.size()) {
                throw JsonParseError("Unterminated string");
            }
            char c = consume();
            if (c == '\\') {
                c = consume();
                switch (c) {
                    case '"': result += '"'; break;
                    case '\\': result += '\\'; break;
                    case '/': result += '/'; break;
                    case 'b': result += '\b'; break;
                    case 'f': result += '\f'; break;
                    case 'n': result += '\n'; break;
                    case 'r': result += '\r'; break;
                    case 't': result += '\t'; break;
                    case 'u': {
                        // Parse 4 hex digits
                        if (pos_ + 4 > json_.size()) {
                            throw JsonParseError("Invalid unicode escape");
                        }
                        std::string hex(json_.substr(pos_, 4));
                        pos_ += 4;
                        unsigned int codepoint = 0;
                        for (char h : hex) {
                            codepoint *= 16;
                            if (h >= '0' && h <= '9') codepoint += h - '0';
                            else if (h >= 'a' && h <= 'f') codepoint += 10 + h - 'a';
                            else if (h >= 'A' && h <= 'F') codepoint += 10 + h - 'A';
                            else throw JsonParseError("Invalid unicode escape");
                        }
                        // Simple UTF-8 encoding
                        if (codepoint < 0x80) {
                            result += static_cast<char>(codepoint);
                        } else if (codepoint < 0x800) {
                            result += static_cast<char>(0xC0 | (codepoint >> 6));
                            result += static_cast<char>(0x80 | (codepoint & 0x3F));
                        } else {
                            result += static_cast<char>(0xE0 | (codepoint >> 12));
                            result += static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F));
                            result += static_cast<char>(0x80 | (codepoint & 0x3F));
                        }
                        break;
                    }
                    default:
                        throw JsonParseError(std::string("Invalid escape: \\") + c);
                }
            } else {
                result += c;
            }
        }
        expect('"');
        return JsonValue(std::move(result));
    }

    JsonValue parse_number() {
        size_t start = pos_;
        if (peek() == '-') consume();

        if (peek() == '0') {
            consume();
        } else if (std::isdigit(peek())) {
            while (std::isdigit(peek())) consume();
        } else {
            throw JsonParseError("Invalid number");
        }

        if (peek() == '.') {
            consume();
            if (!std::isdigit(peek())) {
                throw JsonParseError("Invalid number: expected digit after decimal");
            }
            while (std::isdigit(peek())) consume();
        }

        if (peek() == 'e' || peek() == 'E') {
            consume();
            if (peek() == '+' || peek() == '-') consume();
            if (!std::isdigit(peek())) {
                throw JsonParseError("Invalid number: expected digit in exponent");
            }
            while (std::isdigit(peek())) consume();
        }

        std::string num_str(json_.substr(start, pos_ - start));
        double value = std::stod(num_str);
        return JsonValue(value);
    }

    JsonValue parse_array() {
        expect('[');
        JsonArray arr;
        skip_whitespace();

        if (peek() != ']') {
            arr.push_back(parse_value());
            skip_whitespace();

            while (peek() == ',') {
                consume();
                arr.push_back(parse_value());
                skip_whitespace();
            }
        }

        expect(']');
        return JsonValue(std::move(arr));
    }

    JsonValue parse_object() {
        expect('{');
        JsonObject obj;
        skip_whitespace();

        if (peek() != '}') {
            auto parse_pair = [&]() {
                skip_whitespace();
                if (peek() != '"') {
                    throw JsonParseError("Expected string key in object");
                }
                auto key = parse_string().as_string();
                skip_whitespace();
                expect(':');
                obj[key] = parse_value();
                skip_whitespace();
            };

            parse_pair();
            while (peek() == ',') {
                consume();
                parse_pair();
            }
        }

        expect('}');
        return JsonValue(std::move(obj));
    }
};

void write_escaped_string(std::ostream& os, const std::string& s) {
    os << '"';
    for (char c : s) {
        switch (c) {
            case '"': os << "\\\""; break;
            case '\\': os << "\\\\"; break;
            case '\b': os << "\\b"; break;
            case '\f': os << "\\f"; break;
            case '\n': os << "\\n"; break;
            case '\r': os << "\\r"; break;
            case '\t': os << "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
                    os << buf;
                } else {
                    os << c;
                }
        }
    }
    os << '"';
}

void write_json(std::ostream& os, const JsonValue& value, int indent, int current_indent) {
    std::string indent_str(current_indent, ' ');
    std::string next_indent_str(current_indent + indent, ' ');

    if (value.is_null()) {
        os << "null";
    } else if (value.is_bool()) {
        os << (value.as_bool() ? "true" : "false");
    } else if (value.is_number()) {
        double n = value.as_number();
        if (n == static_cast<long long>(n)) {
            os << static_cast<long long>(n);
        } else {
            os << n;
        }
    } else if (value.is_string()) {
        write_escaped_string(os, value.as_string());
    } else if (value.is_array()) {
        const auto& arr = value.as_array();
        if (arr.empty()) {
            os << "[]";
        } else {
            os << "[";
            if (indent > 0) os << "\n";
            for (size_t i = 0; i < arr.size(); ++i) {
                if (indent > 0) os << next_indent_str;
                write_json(os, arr[i], indent, current_indent + indent);
                if (i + 1 < arr.size()) os << ",";
                if (indent > 0) os << "\n";
            }
            if (indent > 0) os << indent_str;
            os << "]";
        }
    } else if (value.is_object()) {
        const auto& obj = value.as_object();
        if (obj.empty()) {
            os << "{}";
        } else {
            os << "{";
            if (indent > 0) os << "\n";
            size_t i = 0;
            for (const auto& [key, val] : obj) {
                if (indent > 0) os << next_indent_str;
                write_escaped_string(os, key);
                os << ":";
                if (indent > 0) os << " ";
                write_json(os, val, indent, current_indent + indent);
                if (i + 1 < obj.size()) os << ",";
                if (indent > 0) os << "\n";
                ++i;
            }
            if (indent > 0) os << indent_str;
            os << "}";
        }
    }
}

} // anonymous namespace

std::string JsonValue::to_string(int indent) const {
    std::ostringstream os;
    write_json(os, *this, indent, 0);
    return os.str();
}

JsonValue JsonValue::parse(std::string_view json) {
    JsonParser parser(json);
    return parser.parse();
}

} // namespace ts0
