#pragma once
// JSON Parser - minimal implementation for ts0 config

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace json {

struct Value;
using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

struct Value {
    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> data;

    Value() : data(nullptr) {}
    Value(std::nullptr_t) : data(nullptr) {}
    Value(bool b) : data(b) {}
    Value(double d) : data(d) {}
    Value(int i) : data(static_cast<double>(i)) {}
    Value(const std::string& s) : data(s) {}
    Value(std::string&& s) : data(std::move(s)) {}
    Value(const char* s) : data(std::string(s)) {}
    Value(Array arr) : data(std::move(arr)) {}
    Value(Object obj) : data(std::move(obj)) {}

    bool is_null() const { return std::holds_alternative<std::nullptr_t>(data); }
    bool is_bool() const { return std::holds_alternative<bool>(data); }
    bool is_number() const { return std::holds_alternative<double>(data); }
    bool is_string() const { return std::holds_alternative<std::string>(data); }
    bool is_array() const { return std::holds_alternative<Array>(data); }
    bool is_object() const { return std::holds_alternative<Object>(data); }

    bool as_bool() const { return std::get<bool>(data); }
    double as_number() const { return std::get<double>(data); }
    const std::string& as_string() const { return std::get<std::string>(data); }
    const Array& as_array() const { return std::get<Array>(data); }
    const Object& as_object() const { return std::get<Object>(data); }
    Object& as_object() { return std::get<Object>(data); }

    const Value& operator[](const std::string& key) const {
        static Value null_val;
        if (!is_object()) return null_val;
        auto& obj = as_object();
        auto it = obj.find(key);
        return it != obj.end() ? it->second : null_val;
    }

    std::optional<std::string> get_string(const std::string& key) const {
        if (!is_object()) return std::nullopt;
        auto& obj = as_object();
        auto it = obj.find(key);
        if (it != obj.end() && it->second.is_string()) {
            return it->second.as_string();
        }
        return std::nullopt;
    }

    std::optional<bool> get_bool(const std::string& key) const {
        if (!is_object()) return std::nullopt;
        auto& obj = as_object();
        auto it = obj.find(key);
        if (it != obj.end() && it->second.is_bool()) {
            return it->second.as_bool();
        }
        return std::nullopt;
    }
};

class Parser {
    std::string_view src;
    size_t pos = 0;

    void skip_ws() {
        while (pos < src.size() && std::isspace(src[pos])) ++pos;
    }

    char peek() { return pos < src.size() ? src[pos] : '\0'; }
    char get() { return pos < src.size() ? src[pos++] : '\0'; }

    std::string parse_string() {
        std::string result;
        get(); // consume opening quote
        while (pos < src.size() && src[pos] != '"') {
            if (src[pos] == '\\' && pos + 1 < src.size()) {
                ++pos;
                switch (src[pos]) {
                    case 'n': result += '\n'; break;
                    case 't': result += '\t'; break;
                    case 'r': result += '\r'; break;
                    case '\\': result += '\\'; break;
                    case '"': result += '"'; break;
                    default: result += src[pos]; break;
                }
            } else {
                result += src[pos];
            }
            ++pos;
        }
        if (pos < src.size()) ++pos; // consume closing quote
        return result;
    }

    Value parse_number() {
        size_t start = pos;
        if (src[pos] == '-') ++pos;
        while (pos < src.size() && std::isdigit(src[pos])) ++pos;
        if (pos < src.size() && src[pos] == '.') {
            ++pos;
            while (pos < src.size() && std::isdigit(src[pos])) ++pos;
        }
        if (pos < src.size() && (src[pos] == 'e' || src[pos] == 'E')) {
            ++pos;
            if (pos < src.size() && (src[pos] == '+' || src[pos] == '-')) ++pos;
            while (pos < src.size() && std::isdigit(src[pos])) ++pos;
        }
        return Value(std::stod(std::string(src.substr(start, pos - start))));
    }

    Value parse_array() {
        Array arr;
        get(); // consume '['
        skip_ws();

        while (peek() != ']' && pos < src.size()) {
            arr.push_back(parse_value());
            skip_ws();
            if (peek() == ',') get();
            skip_ws();
        }

        if (peek() == ']') get();
        return Value(std::move(arr));
    }

    Value parse_object() {
        Object obj;
        get(); // consume '{'
        skip_ws();

        while (peek() != '}' && pos < src.size()) {
            skip_ws();
            if (peek() != '"') break;
            std::string key = parse_string();
            skip_ws();
            if (peek() == ':') get();
            skip_ws();
            obj[key] = parse_value();
            skip_ws();
            if (peek() == ',') get();
        }

        if (peek() == '}') get();
        return Value(std::move(obj));
    }

    Value parse_value() {
        skip_ws();
        char c = peek();

        if (c == '"') return Value(parse_string());
        if (c == '{') return parse_object();
        if (c == '[') return parse_array();
        if (c == 't') { pos += 4; return Value(true); }
        if (c == 'f') { pos += 5; return Value(false); }
        if (c == 'n') { pos += 4; return Value(nullptr); }
        if (c == '-' || std::isdigit(c)) return parse_number();

        return Value(nullptr);
    }

public:
    Value parse(std::string_view json) {
        src = json;
        pos = 0;
        return parse_value();
    }
};

inline std::string stringify(const Value& val, int indent = 0);

inline std::string stringify_object(const Object& obj, int indent) {
    if (obj.empty()) return "{}";
    std::string result = "{\n";
    std::string pad(indent + 2, ' ');
    bool first = true;
    for (const auto& [k, v] : obj) {
        if (!first) result += ",\n";
        first = false;
        result += pad + "\"" + k + "\": " + stringify(v, indent + 2);
    }
    result += "\n" + std::string(indent, ' ') + "}";
    return result;
}

inline std::string stringify(const Value& val, int indent) {
    if (val.is_null()) return "null";
    if (val.is_bool()) return val.as_bool() ? "true" : "false";
    if (val.is_number()) {
        double d = val.as_number();
        if (d == static_cast<int>(d)) {
            return std::to_string(static_cast<int>(d));
        }
        return std::to_string(d);
    }
    if (val.is_string()) {
        std::string result = "\"";
        for (char c : val.as_string()) {
            switch (c) {
                case '"': result += "\\\""; break;
                case '\\': result += "\\\\"; break;
                case '\n': result += "\\n"; break;
                case '\t': result += "\\t"; break;
                case '\r': result += "\\r"; break;
                default: result += c; break;
            }
        }
        return result + "\"";
    }
    if (val.is_array()) {
        if (val.as_array().empty()) return "[]";
        std::string result = "[\n";
        std::string pad(indent + 2, ' ');
        bool first = true;
        for (const auto& v : val.as_array()) {
            if (!first) result += ",\n";
            first = false;
            result += pad + stringify(v, indent + 2);
        }
        result += "\n" + std::string(indent, ' ') + "]";
        return result;
    }
    if (val.is_object()) {
        return stringify_object(val.as_object(), indent);
    }
    return "null";
}

inline Value parse(const std::string& json) {
    Parser p;
    return p.parse(json);
}

} // namespace json
