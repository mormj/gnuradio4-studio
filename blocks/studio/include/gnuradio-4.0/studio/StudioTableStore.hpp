// SPDX-License-Identifier: MIT
#pragma once
#include <gnuradio-4.0/studio/StudioAnnotationStore.hpp>
namespace gr::studio::tables {
using annotations::epoch;
using annotations::integer;
using annotations::keys;
using annotations::object;
using annotations::quote;
using annotations::text;
inline std::string json(const property_map& m, unsigned depth = 0) {
    if (depth > 6 || m.size() > 64) {
        throw std::invalid_argument("metadata nesting/field bound");
    }
    std::string out   = "{";
    bool        first = true;
    for (auto& [k, v] : m) {
        if (k.size() > 512) {
            throw std::invalid_argument("oversized key");
        }
        if (!first) {
            out += ',';
        }
        first = false;
        out += quote(k) + ":";
        if (auto p = v.get_if<property_map>()) {
            out += json(*p, depth + 1);
        } else if (auto p = v.get_if<std::pmr::string>()) {
            if (p->size() > 4096) {
                throw std::invalid_argument("oversized text");
            }
            out += quote(*p);
        } else if (auto p = v.get_if<std::uint64_t>()) {
            out += quote(std::to_string(*p));
        } else if (auto p = v.get_if<std::int64_t>()) {
            out += quote(std::to_string(*p));
        } else if (auto p = v.get_if<double>()) {
            if (!std::isfinite(*p)) {
                throw std::invalid_argument("nonfinite number");
            }
            std::ostringstream o;
            o.imbue(std::locale::classic());
            o << std::setprecision(17) << *p;
            out += o.str();
        } else if (auto p = v.get_if<bool>()) {
            out += *p ? "true" : "false";
        } else if (v.is_monostate()) {
            out += "null";
        } else {
            throw std::invalid_argument("unsupported native value");
        }
    }
    return out + "}";
}
// Conservative native + JSON accounting, computed without encoding on the GR4
// worker.
inline std::size_t bound(const property_map& m, unsigned depth = 0) {
    if (depth > 6 || m.size() > 64) {
        throw std::invalid_argument("metadata nesting/field bound");
    }
    std::size_t bytes = 128;
    for (auto& [k, v] : m) {
        if (k.size() > 512) {
            throw std::invalid_argument("oversized key");
        }
        bytes += 128 + 6 * k.size();
        if (auto p = v.get_if<property_map>()) {
            bytes += bound(*p, depth + 1);
        } else if (auto p = v.get_if<std::pmr::string>()) {
            if (p->size() > 4096) {
                throw std::invalid_argument("oversized text");
            }
            bytes += 6 * p->size();
        } else if (auto p = v.get_if<double>()) {
            if (!std::isfinite(*p)) {
                throw std::invalid_argument("nonfinite number");
            }
            bytes += 32;
        } else if (v.get_if<std::uint64_t>() || v.get_if<std::int64_t>() || v.get_if<bool>() || v.is_monostate()) {
            bytes += 32;
        } else {
            throw std::invalid_argument("unsupported native value");
        }
    }
    return bytes;
}

inline void validateSchema(const property_map& columns) {
    if (columns.size() > 64) {
        throw std::invalid_argument("too many columns");
    }
    std::set<std::string> names;
    for (std::size_t i = 0; i < columns.size(); ++i) {
        auto& c = object(columns, std::to_string(i));
        keys(c, {"key", "label", "type", "nullable", "unit"});
        auto key = text(c, "key");
        text(c, "label");
        if (!names.insert(key).second) {
            throw std::invalid_argument("duplicate column");
        }
        auto type = text(c, "type");
        if (type != "string" && type != "uint64" && type != "int64" && type != "float64" && type != "boolean") {
            throw std::invalid_argument("unknown column type");
        }
        if (!c.contains("nullable") || !c.at("nullable").get_if<bool>()) {
            throw std::invalid_argument("native bool nullable required");
        }
        if (c.contains("unit")) {
            text(c, "unit");
        }
    }
}
inline std::string schemaJson(const property_map& columns) {
    std::string out = "[";
    for (std::size_t i = 0; i < columns.size(); ++i) {
        if (i) {
            out += ',';
        }
        out += json(object(columns, std::to_string(i)));
    }
    return out + "]";
}
inline void validateRow(const property_map& row, const property_map& columns) {
    keys(row, {"row_id", "revision", "annotation_id", "terminal", "values"});
    if (row.contains("terminal") && !row.at("terminal").get_if<bool>()) {
        throw std::invalid_argument("native bool terminal required");
    }
    text(row, "row_id");
    integer(row, "revision");
    if (row.contains("annotation_id")) {
        text(row, "annotation_id");
    }
    auto& values = object(row, "values");
    if (values.size() != columns.size()) {
        throw std::invalid_argument("complete typed row required");
    }
    for (std::size_t i = 0; i < columns.size(); ++i) {
        auto& c = object(columns, std::to_string(i));
        auto  k = text(c, "key"), type = text(c, "type");
        if (!values.contains(k)) {
            throw std::invalid_argument("missing column value");
        }
        auto& v = values.find(k)->second;
        if (v.is_monostate()) {
            if (!*c.at("nullable").get_if<bool>()) {
                throw std::invalid_argument("nonnullable column");
            }
            continue;
        }
        bool valid = (type == "string" && v.get_if<std::pmr::string>()) || (type == "uint64" && v.get_if<std::uint64_t>()) || (type == "int64" && v.get_if<std::int64_t>()) || (type == "float64" && v.get_if<double>() && std::isfinite(*v.get_if<double>())) || (type == "boolean" && v.get_if<bool>());
        if (!valid) {
            throw std::invalid_argument("column type mismatch: " + k);
        }
        if (type == "string" && v.get_if<std::pmr::string>()->size() > 4096) {
            throw std::invalid_argument("oversized table value");
        }
    }
}
struct Config {
    std::string  run_namespace, producer_instance = "tables";
    property_map columns;
    std::size_t  max_items = 10000, max_bytes = 32 * 1024 * 1024, max_clients = 8, queue_bytes = 4 * 1024 * 1024, snapshot_bytes = 128 * 1024 * 1024;
};
struct Transaction {
    std::function<std::string()> encode;
    std::size_t                  bound    = 0;
    bool                         snapshot = false;
    std::string                  json() const { return encode(); }
};
struct Subscriber {
    std::deque<std::shared_ptr<const Transaction>> pending;
    std::size_t                                    bytes = 0, delta_bytes = 0;
    bool                                           failed = false;
};
class Store {
public:
    std::uint64_t publicationCursor() const {
        std::lock_guard lock(mutex);
        return cursor;
    }
    using SubscriberType = Subscriber;

private:
    struct Entry {
        std::uint64_t revision = 0, order = 0;
        property_map  native;
        std::size_t   accounted = 0;
        bool          terminal  = false;
        bool          deleted() const { return native.empty(); }
        std::size_t   bytes(const std::string& id) const { return 192 + 6 * id.size() + accounted; }
    };
    mutable std::mutex                     mutex;
    Config                                 config;
    property_map                           columns;
    std::size_t                            schema_bytes = 0;
    std::map<std::string, Entry>           items;
    std::vector<std::weak_ptr<Subscriber>> subscribers;
    std::string                            stream_epoch = epoch(), last_error;
    std::uint64_t                          cursor = 0, evicted = 0, dropped = 0, late = 0, duplicates = 0, conflicts = 0, overflows = 0, order = 0;
    std::optional<std::uint64_t>           batch;
    property_map                           last_batch_rows, last_batch_columns;
    std::size_t                            retained = 0;
    bool                                   fault    = false;
    std::size_t                            envelopeBound() const { return 2048 + 6 * (config.run_namespace.size() + config.producer_instance.size() + 128); }
    std::string                            envelope(bool snapshot, std::uint64_t base = 0) const { return "{\"payload_format\":\"table-updates-json-v1\",\"message\":" + quote(snapshot ? "snapshot" : "delta") + ",\"scope\":{\"run_namespace\":" + quote(config.run_namespace) + ",\"producer_instance\":" + quote(config.producer_instance) + "},\"stream_epoch\":" + quote(stream_epoch) + ",\"cursor\":" + quote(std::to_string(cursor)) + ",\"retention\":{\"max_items\":" + std::to_string(config.max_items) + ",\"max_bytes\":" + std::to_string(config.max_bytes) + ",\"evicted_items\":" + quote(std::to_string(evicted)) + ",\"dropped_updates\":" + quote(std::to_string(dropped)) + "}" + (snapshot ? "" : ",\"base_cursor\":" + quote(std::to_string(base))); }
    std::shared_ptr<const Transaction>     snapshotLocked() const {
        auto captured         = items;
        auto captured_columns = columns;
        auto header           = envelope(true);
        auto encode           = [captured = std::move(captured), header = std::move(header), captured_columns = std::move(captured_columns)] {
            std::string values, dead;
            for (auto& [id, e] : captured) {
                auto& out = e.deleted() ? dead : values;
                if (!out.empty()) {
                    out += ',';
                }
                out += e.deleted() ? "{\"id\":" + quote(id) + ",\"revision\":" + quote(std::to_string(e.revision)) + "}" : json(e.native);
            }
            return header + ",\"columns\":" + schemaJson(captured_columns) + ",\"rows\":[" + values + "],\"tombstones\":[" + dead + "]}";
        };
        return std::make_shared<Transaction>(Transaction{std::move(encode), retained + envelopeBound(), true});
    }

    void publish(std::shared_ptr<const Transaction> t) {
        std::erase_if(subscribers, [](auto& w) { return w.expired(); });
        for (auto& w : subscribers) {
            if (auto s = w.lock(); s && !s->failed) {
                if (t->bound > (t->snapshot ? config.snapshot_bytes : config.queue_bytes) || (t->snapshot ? s->bytes + t->bound > config.snapshot_bytes + config.queue_bytes : s->delta_bytes + t->bound > config.queue_bytes)) {
                    s->failed = true;
                    s->pending.clear();
                    s->bytes = s->delta_bytes = 0;
                    ++overflows;
                } else {
                    s->pending.push_back(t);
                    s->bytes += t->bound;
                    if (!t->snapshot) {
                        s->delta_bytes += t->bound;
                    }
                }
            }
        }
    }

public:
    void configure(Config c, bool preserveSubscribers = false) {
        if (c.run_namespace.empty() || c.run_namespace.size() > 512 || c.producer_instance.empty() || c.producer_instance.size() > 512 || !c.max_items || c.max_items > 100000 || c.max_bytes < 1024 || c.max_bytes > 128 * 1024 * 1024 || !c.max_clients || c.max_clients > 64 || c.queue_bytes < 1024 || c.queue_bytes > 128 * 1024 * 1024 || c.snapshot_bytes < 4096 || c.snapshot_bytes > 128 * 1024 * 1024) {
            throw std::invalid_argument("invalid table limits/scope");
        }
        std::lock_guard lock(mutex);
        if (!preserveSubscribers) {
            for (auto& w : subscribers) {
                if (auto s = w.lock()) {
                    s->failed = true;
                    s->pending.clear();
                    s->bytes = s->delta_bytes = 0;
                }
            }
            subscribers.clear();
        }
        validateSchema(c.columns);
        auto cb = bound(c.columns);
        if (cb + 2048 + 6 * (c.run_namespace.size() + c.producer_instance.size() + 128) > std::min(c.max_bytes, c.snapshot_bytes)) {
            throw std::invalid_argument("schema exceeds byte budget");
        }
        config       = std::move(c);
        columns      = config.columns;
        schema_bytes = cb;
        items.clear();
        retained = schema_bytes;
        cursor = evicted = dropped = late = duplicates = conflicts = overflows = order = 0;
        batch.reset();
        last_batch_rows.clear();
        last_batch_columns.clear();
        fault = false;
        last_error.clear();
        stream_epoch = epoch();
        if (preserveSubscribers) {
            publish(snapshotLocked());
        }
    }
    std::shared_ptr<Subscriber> subscribe() {
        std::lock_guard lock(mutex);
        std::erase_if(subscribers, [](auto& w) { return w.expired(); });
        if (fault || subscribers.size() >= config.max_clients) {
            return {};
        }
        auto s = std::make_shared<Subscriber>();
        auto t = snapshotLocked();
        if (t->bound > config.snapshot_bytes) {
            return {};
        }
        s->pending.push_back(t);
        s->bytes = t->bound;
        subscribers.push_back(s);
        return s;
    }
    std::shared_ptr<const Transaction> take(const std::shared_ptr<Subscriber>& s, bool& failed) {
        std::lock_guard lock(mutex);
        failed = s->failed;
        if (failed || s->pending.empty()) {
            return {};
        }
        auto t = s->pending.front();
        s->pending.pop_front();
        s->bytes -= t->bound;
        if (!t->snapshot) {
            s->delta_bytes -= t->bound;
        }
        return t;
    }
    std::string snapshot() const {
        std::lock_guard lock(mutex);
        return snapshotLocked()->json();
    }
    std::array<std::uint64_t, 6> diagnostics() const {
        std::lock_guard lock(mutex);
        return {dropped, duplicates, late, conflicts, overflows, items.size()};
    }
    std::string lastError() const {
        std::lock_guard lock(mutex);
        return last_error;
    }
    bool push(const DataSet<double>& d) {
        std::lock_guard lock(mutex);
        try {
            if (fault) {
                throw std::invalid_argument("table stream faulted; fresh execution required");
            }
            if (d.extents.size() != 1 || d.extents[0] > 8192 || d.meta_information.size() != 1 || d.axis_names != std::vector<std::string>{"row_index"} || d.axis_units != std::vector<std::string>{"1"} || d.signal_names != std::vector<std::string>{"row_ordinal"} || d.signal_quantities != std::vector<std::string>{"ordinal"} || d.signal_units != std::vector<std::string>{"1"} || d.axis_values.size() != 1 || d.axis_values[0].size() != d.extents[0] || d.signal_values.size() != d.extents[0]) {
                throw std::invalid_argument("invalid native ordinal carrier");
            }
            auto& m       = d.meta_information[0];
            auto  version = m.at("contract_version").get_if<std::uint32_t>();
            if (text(m, "kind") != "studio_table_updates" || !version || *version != 1 || integer(m, "update_count") != d.extents[0]) {
                throw std::invalid_argument("invalid table contract");
            }
            auto& scope = object(m, "scope");
            if (text(scope, "run_namespace") != config.run_namespace || text(scope, "producer_instance") != config.producer_instance) {
                throw std::invalid_argument("scope mismatch");
            }
            auto        ordinal  = integer(m, "producer_batch_ordinal");
            const auto& incoming = m.contains("columns") ? object(m, "columns") : columns;
            validateSchema(incoming);
            auto incoming_bytes = bound(incoming);
            if (incoming_bytes + envelopeBound() > std::min(config.max_bytes, config.snapshot_bytes)) {
                throw std::invalid_argument("schema exceeds byte budget");
            }
            bool  schema_changed = incoming != columns;
            auto& rows           = object(m, "rows");
            if (rows.size() != d.extents[0]) {
                throw std::invalid_argument("invalid operation count");
            }
            if (batch && ordinal < *batch) {
                ++late;
                return false;
            }
            if (batch && ordinal == *batch) {
                if (rows == last_batch_rows && incoming == last_batch_columns) {
                    ++duplicates;
                    return true;
                }
                ++conflicts;
                fault = true;
                for (auto& w : subscribers) {
                    if (auto sub = w.lock()) {
                        sub->failed = true;
                        sub->pending.clear();
                        sub->bytes = sub->delta_bytes = 0;
                    }
                }
                throw std::invalid_argument("conflicting producer batch replay");
            }
            struct Op {
                std::string  id;
                property_map event;
                Entry        entry;
                bool         clear = false;
            };
            std::vector<Op>              ops;
            std::map<std::string, Entry> touched;
            bool                         cleared     = schema_changed;
            std::size_t                  batch_bytes = 0;
            for (std::size_t i = 0; i < d.extents[0]; ++i) {
                if (d.axis_values[0][i] != double(i) || d.signal_values[i] != double(i)) {
                    throw std::invalid_argument("invalid ordinal values");
                }
                auto& r         = object(rows, std::to_string(i));
                auto  operation = text(r, "operation");
                Op    op;
                if (operation == "clear") {
                    keys(r, {"operation"});
                    op.clear = true;
                    op.event = r;
                    touched.clear();
                    cleared = true;
                    ops.push_back(op);
                    continue;
                }
                if (operation == "upsert") {
                    keys(r, {"operation", "value"});
                    auto& a = object(r, "value");
                    validateRow(a, incoming);
                    op.id              = text(a, "row_id");
                    op.entry.revision  = integer(a, "revision");
                    op.entry.accounted = bound(a);
                    batch_bytes += op.entry.accounted;
                    if (batch_bytes > config.max_bytes) {
                        throw std::invalid_argument("native operation batch exceeds byte budget");
                    }
                    op.entry.native   = a;
                    op.entry.terminal = a.contains("terminal") && *a.at("terminal").get_if<bool>();
                } else if (operation == "delete") {
                    keys(r, {"operation", "row_id", "revision"});
                    op.id             = text(r, "row_id");
                    op.entry.revision = integer(r, "revision");
                } else {
                    throw std::invalid_argument("invalid operation");
                }
                if (op.entry.bytes(op.id) + incoming_bytes + envelopeBound() > std::min(config.max_bytes, config.snapshot_bytes)) {
                    throw std::invalid_argument("table exceeds byte budget");
                }
                const Entry* old = nullptr;
                if (auto it = touched.find(op.id); it != touched.end()) {
                    old = &it->second;
                } else if (!cleared) {
                    auto it = items.find(op.id);
                    if (it != items.end()) {
                        old = &it->second;
                    }
                }
                if (old) {
                    if (op.entry.revision < old->revision) {
                        ++late;
                        continue;
                    }
                    if (op.entry.revision == old->revision) {
                        if (op.entry.native == old->native) {
                            ++duplicates;
                            continue;
                        }
                        ++conflicts;
                        fault = true;
                        for (auto& w : subscribers) {
                            if (auto s = w.lock()) {
                                s->failed = true;
                                s->pending.clear();
                                s->bytes = s->delta_bytes = 0;
                            }
                        }
                        throw std::invalid_argument("conflicting equal table revision");
                    }
                }
                touched[op.id] = op.entry;
                op.event       = r;
                ops.push_back(std::move(op));
            }
            if (ops.size() > UINT64_MAX - cursor || ops.size() > UINT64_MAX - order) {
                throw std::overflow_error("table publication ordinal exhausted");
            }
            auto next_batch_rows    = rows;
            auto next_batch_columns = incoming;
            if (schema_changed) {
                columns      = incoming;
                schema_bytes = incoming_bytes;
                items.clear();
                retained     = schema_bytes;
                stream_epoch = epoch();
            }
            // All operations validated before changing authoritative state. One
            // bounded transaction per operation.
            for (auto& op : ops) {
                if (cursor == UINT64_MAX || order == UINT64_MAX) {
                    throw std::overflow_error("table cursor exhausted");
                }
                auto        base  = cursor++;
                bool        reset = false;
                std::string removed;
                if (op.clear) {
                    items.clear();
                    retained = schema_bytes;
                } else {
                    auto it = items.find(op.id);
                    if (it != items.end()) {
                        retained -= it->second.bytes(it->first);
                    }
                    op.entry.order = ++order;
                    items[op.id]   = op.entry;
                    retained += op.entry.bytes(op.id);
                }
                // Count includes bounded tombstones; explicitly terminal items first,
                // then deterministic oldest accepted update.
                while (items.size() > config.max_items || retained + envelopeBound() > std::min(config.max_bytes, config.snapshot_bytes)) {
                    auto victim = items.end();
                    for (auto it = items.begin(); it != items.end(); ++it) {
                        if (victim == items.end() || std::pair{!it->second.terminal, it->second.order} < std::pair{!victim->second.terminal, victim->second.order}) {
                            victim = it;
                        }
                    }
                    if (victim == items.end()) {
                        break;
                    }
                    reset |= victim->second.deleted();
                    if (!removed.empty()) {
                        removed += ',';
                    }
                    removed += quote(victim->first);
                    retained -= victim->second.bytes(victim->first);
                    items.erase(victim);
                    ++evicted;
                }
                if (schema_changed) {
                } else if (reset) {
                    stream_epoch = epoch();
                    publish(snapshotLocked());
                } else {
                    auto header = envelope(false, base);
                    auto event  = std::move(op.event);
                    auto bytes  = bound(event) + envelopeBound() + removed.size();
                    auto encode = [header = std::move(header), event = std::move(event), removed = std::move(removed)] { return header + ",\"events\":[" + json(event) + "],\"evicted_ids\":[" + removed + "]}"; };
                    publish(std::make_shared<Transaction>(Transaction{std::move(encode), bytes, false}));
                }
            }
            if (schema_changed) {
                publish(snapshotLocked());
            }
            last_batch_rows    = std::move(next_batch_rows);
            last_batch_columns = std::move(next_batch_columns);
            batch              = ordinal;
            return true;
        } catch (const std::exception& e) {
            last_error = e.what();
            dropped += std::max<std::uint64_t>(1, d.extents.size() == 1 && d.extents[0] >= 0 ? std::min<std::uint64_t>(d.extents[0], 8192) : 1);
            return false;
        }
    }
};
} // namespace gr::studio::tables
