#pragma once

#include <string>
#include <string_view>
#include <map>
#include <vector>
#include <variant>
#include <optional>
#include <stdexcept>

namespace ts0 {

class JsonValue;

using JsonNull = std::monostate;
using JsonBool = bool;
using JsonNumber = double;
using JsonString = std::string;
using JsonArray = std::vector<JsonValue>;
using JsonObject = std::map<std::string, JsonValue>;

class JsonValue {
public:
    using Value = std::variant<JsonNull, JsonBool, JsonNumber, JsonString, JsonArray, JsonObject>;

    JsonValue() : value_(JsonNull{}) {}
    JsonValue(std::nullptr_t) : value_(JsonNull{}) {}
    JsonValue(bool b) : value_(b) {}
    JsonValue(int n) : value_(static_cast<double>(n)) {}
    JsonValue(double n) : value_(n) {}
    JsonValue(const char* s) : value_(std::string(s)) {}
    JsonValue(std::string s) : value_(std::move(s)) {}
    JsonValue(JsonArray arr) : value_(std::move(arr)) {}
    JsonValue(JsonObject obj) : value_(std::move(obj)) {}

    bool is_null() const { return std::holds_alternative<JsonNull>(value_); }
    bool is_bool() const { return std::holds_alternative<JsonBool>(value_); }
    bool is_number() const { return std::holds_alternative<JsonNumber>(value_); }
    bool is_string() const { return std::holds_alternative<JsonString>(value_); }
    bool is_array() const { return std::holds_alternative<JsonArray>(value_); }
    bool is_object() const { return std::holds_alternative<JsonObject>(value_); }

    bool as_bool() const { return std::get<JsonBool>(value_); }
    double as_number() const { return std::get<JsonNumber>(value_); }
    const std::string& as_string() const { return std::get<JsonString>(value_); }
    const JsonArray& as_array() const { return std::get<JsonArray>(value_); }
    const JsonObject& as_object() const { return std::get<JsonObject>(value_); }

    JsonArray& as_array() { return std::get<JsonArray>(value_); }
    JsonObject& as_object() { return std::get<JsonObject>(value_); }

    // Object access
    JsonValue& operator[](const std::string& key) {
        if (!is_object()) value_ = JsonObject{};
        return std::get<JsonObject>(value_)[key];
    }

    const JsonValue& operator[](const std::string& key) const {
        static JsonValue null_value;
        if (!is_object()) return null_value;
        auto& obj = std::get<JsonObject>(value_);
        auto it = obj.find(key);
        return it != obj.end() ? it->second : null_value;
    }

    bool contains(const std::string& key) const {
        if (!is_object()) return false;
        return std::get<JsonObject>(value_).count(key) > 0;
    }

    // Array access
    JsonValue& operator[](size_t index) {
        return std::get<JsonArray>(value_)[index];
    }

    const JsonValue& operator[](size_t index) const {
        return std::get<JsonArray>(value_)[index];
    }

    size_t size() const {
        if (is_array()) return std::get<JsonArray>(value_).size();
        if (is_object()) return std::get<JsonObject>(value_).size();
        return 0;
    }

    // Serialization
    std::string to_string(int indent = 0) const;

    // Parsing
    static JsonValue parse(std::string_view json);

private:
    Value value_;
};

class JsonParseError : public std::runtime_error {
public:
    JsonParseError(const std::string& msg) : std::runtime_error(msg) {}
};

} // namespace ts0
