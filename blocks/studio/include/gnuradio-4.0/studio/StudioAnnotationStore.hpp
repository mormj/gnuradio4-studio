// SPDX-License-Identifier: MIT
#pragma once
#include <cctype>
#include <functional>
#include <gnuradio-4.0/studio/StudioDataSetWaterfallStore.hpp>
#include <map>
#include <set>
#include <tuple>

namespace gr::studio::annotations {
using dataset_waterfall::epoch;
using dataset_waterfall::quote;
// The carrier stays entirely native. Only the sink boundary writes decimal JSON
// integers.
inline const property_map& object(const property_map& m, const std::string& k) {
    auto i = m.find(k);
    if (i == m.end()) {
        throw std::invalid_argument("missing map: " + k);
    }
    auto p = i->second.get_if<property_map>();
    if (!p) {
        throw std::invalid_argument("expected map: " + k);
    }
    return *p;
}
inline std::string text(const property_map& m, const std::string& k, std::size_t max = 512, bool empty = false) {
    auto i = m.find(k);
    if (i == m.end()) {
        throw std::invalid_argument("missing string: " + k);
    }
    auto p = i->second.get_if<std::pmr::string>();
    if (!p || p->size() > max || (!empty && p->empty())) {
        throw std::invalid_argument("invalid string: " + k);
    }
    return std::string(*p);
}
inline std::uint64_t integer(const property_map& m, const std::string& k) {
    auto i = m.find(k);
    if (i == m.end() || !i->second.get_if<std::uint64_t>()) {
        throw std::invalid_argument("expected native uint64: " + k);
    }
    return *i->second.get_if<std::uint64_t>();
}
inline double number(const property_map& m, const std::string& k) {
    auto i = m.find(k);
    if (i == m.end() || !i->second.get_if<double>() || !std::isfinite(*i->second.get_if<double>())) {
        throw std::invalid_argument("expected finite double: " + k);
    }
    return *i->second.get_if<double>();
}
inline void keys(const property_map& m, std::initializer_list<std::string_view> allowed) {
    for (auto& [k, v] : m) {
        (void)v;
        if (std::ranges::find(allowed, std::string_view(k)) == allowed.end()) {
            throw std::invalid_argument("unknown field: " + std::string(k));
        }
    }
}
inline std::string json(const property_map& m, unsigned depth = 0) {
    if (depth > 6 || m.size() > 32) {
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
    if (depth > 6 || m.size() > 32) {
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
inline void frame(const property_map& m) {
    keys(m, {"run_namespace", "source_id", "acquisition_id", "source_epoch", "sequence"});
    for (auto k : {"run_namespace", "source_id", "acquisition_id", "source_epoch"}) {
        text(m, k);
    }
    integer(m, "sequence");
}
inline property_map normalize_annotation(const property_map&);
inline void         annotation(const property_map& m, const std::string& run) {
    if (m.contains("sigmf") && normalize_annotation(object(m, "sigmf")) != m) {
        throw std::invalid_argument("inconsistent SigMF annotation content");
    }
    keys(m, {"annotation_id", "revision", "geometry", "x_axis", "y_axis", "label", "style", "metadata", "sigmf"});
    text(m, "annotation_id");
    integer(m, "revision");
    text(m, "label", 256, true);
    auto& x = object(m, "x_axis");
    keys(x, {"kind", "unit"});
    auto xkind = text(x, "kind"), unit = text(x, "unit");
    if (xkind != "frequency" && xkind != "numeric") {
        throw std::invalid_argument("unsupported x axis");
    }
    if (xkind == "frequency" && unit != "Hz") {
        throw std::invalid_argument("frequency requires Hz");
    }
    auto& g    = object(m, "geometry");
    auto  kind = text(g, "kind");
    if (kind == "point") {
        keys(g, {"kind", "x", "y"});
        number(g, "x");
        if (g.contains("y")) {
            number(g, "y");
        }
    } else if (kind == "range" || kind == "rectangle") {
        keys(g, {"kind", "x_min", "x_max"});
        if (number(g, "x_min") > number(g, "x_max")) {
            throw std::invalid_argument("reversed frequency range");
        }
    } else {
        throw std::invalid_argument("unsupported geometry");
    }
    if (kind == "rectangle" && !m.contains("y_axis")) {
        throw std::invalid_argument("rectangle requires y axis");
    }
    if (m.contains("y_axis")) {
        auto& y     = object(m, "y_axis");
        auto  ykind = text(y, "kind");
        if (ykind == "observation") {
            keys(y, {"kind", "first", "last"});
            auto& a = object(y, "first");
            auto& b = object(y, "last");
            frame(a);
            frame(b);
            for (auto k : {"run_namespace", "source_id", "acquisition_id", "source_epoch"}) {
                if (text(a, k) != text(b, k)) {
                    throw std::invalid_argument("cross-partition support");
                }
            }
            if (text(a, "run_namespace") != run || integer(a, "sequence") > integer(b, "sequence")) {
                throw std::invalid_argument("invalid observation interval");
            }
            if ((kind != "rectangle" && kind != "range") || xkind != "frequency") {
                throw std::invalid_argument("unsupported observation geometry");
            }
        } else if (ykind == "sample") {
            keys(y, {"kind", "recording_id", "start", "count"});
            text(y, "recording_id");
            const auto start = integer(y, "start"), max = std::uint64_t(INT64_MAX);
            if (start > max) {
                throw std::invalid_argument("invalid sample start");
            }
            if (y.contains("count")) {
                auto count = integer(y, "count");
                if (count > max || (count && start > max - (count - 1))) {
                    throw std::invalid_argument("invalid sample interval");
                }
            }
        } else if (ykind == "numeric") {
            keys(y, {"kind", "min", "max", "unit"});
            text(y, "unit");
            if (number(y, "min") > number(y, "max")) {
                throw std::invalid_argument("reversed numeric range");
            }
        } else if (ykind == "qualified_time") {
            keys(y, {"kind", "first_unix_ns", "last_unix_ns", "provenance"});
            auto provenance = text(y, "provenance");
            if (provenance == "unknown" || provenance == "device_unzoned") {
                throw std::invalid_argument("qualified time requires known timestamp provenance");
            }
            auto a = y.at("first_unix_ns").get_if<std::int64_t>(), b = y.at("last_unix_ns").get_if<std::int64_t>();
            if (!a || !b || *a > *b) {
                throw std::invalid_argument("expected ordered native int64 time");
            }
        } else {
            throw std::invalid_argument("unsupported y axis");
        }
    } else if (g.contains("y")) {
        throw std::invalid_argument("point y requires axis");
    }
    if (m.contains("style")) {
        auto& s = object(m, "style");
        keys(s, {"state", "color", "line", "opacity", "terminal"});
        if (s.contains("terminal") && !s.at("terminal").get_if<bool>()) {
            throw std::invalid_argument("terminal style requires bool");
        }
        for (auto k : {"state", "color"}) {
            if (s.contains(k)) {
                text(s, k);
            }
        }
        if (s.contains("line")) {
            auto l = text(s, "line");
            if (l != "solid" && l != "dashed") {
                throw std::invalid_argument("invalid line");
            }
        }
        if (s.contains("opacity")) {
            auto n = number(s, "opacity");
            if (n < 0 || n > 1) {
                throw std::invalid_argument("invalid opacity");
            }
        }
    }
    if (m.contains("metadata")) {
        for (auto& [k, v] : object(m, "metadata")) {
            (void)k;
            if (v.get_if<property_map>()) {
                throw std::invalid_argument("primitive metadata required");
            }
            // Exact metadata integers must be explicit decimal strings (per wire
            // primitive schema).
            if (v.get_if<std::uint64_t>() || v.get_if<std::int64_t>()) {
                throw std::invalid_argument("metadata integers require decimal strings");
            }
        }
    }
}
// SigMF core content, with explicit GR4 live-stream extensions. This is an
// annotation segment interface, not a complete .sigmf-meta recording.
// Never reinterpret an observation sequence as an IQ sample index.
inline property_map normalize_annotation(const property_map& input) {
    if (!input.contains("core:freq_lower_edge")) {
        if (std::ranges::any_of(input, [](const auto& field) { return std::string_view(field.first).starts_with("core:"); })) {
            throw std::invalid_argument("spectral SigMF annotations require both frequency edges");
        }
        return input; // Legacy plot-annotation interface.
    }
    // Bound before copying arbitrary producer metadata.
    (void)bound(input);
    const auto low = number(input, "core:freq_lower_edge"), high = number(input, "core:freq_upper_edge");
    if (low > high || low < -1e12 || high > 1e12) {
        throw std::invalid_argument("invalid SigMF frequency edges");
    }
    for (const auto& [k, v] : input) {
        (void)v;
        const std::string_view name(k);
        if (name.starts_with("core:") && name != "core:sample_start" && name != "core:sample_count" && name != "core:freq_lower_edge" && name != "core:freq_upper_edge" && name != "core:label" && name != "core:comment" && name != "core:generator" && name != "core:uuid") {
            throw std::invalid_argument("unsupported SigMF core annotation field");
        }
        if (name.find(':') == std::string_view::npos) {
            throw std::invalid_argument("SigMF annotation fields must be namespaced");
        }
    }
    std::string id = input.contains("gr4:annotation_id") ? text(input, "gr4:annotation_id") : text(input, "core:uuid");
    if (input.contains("core:uuid")) {
        const auto uuid = text(input, "core:uuid");
        if (uuid.size() != 36) {
            throw std::invalid_argument("invalid SigMF UUID");
        }
        for (std::size_t i = 0; i < uuid.size(); ++i) {
            const bool dash = i == 8 || i == 13 || i == 18 || i == 23;
            if (dash ? uuid[i] != '-' : !std::isxdigit(static_cast<unsigned char>(uuid[i]))) {
                throw std::invalid_argument("invalid SigMF UUID");
            }
        }
    }
    const auto label = input.contains("core:label") ? text(input, "core:label", 256, true) : std::string{};
    for (const auto* k : {"core:comment", "core:generator"}) {
        if (input.contains(k)) {
            text(input, k, 4096, true);
        }
    }
    property_map a{{"annotation_id", id}, {"revision", integer(input, "gr4:revision")}, {"label", label}, {"geometry", property_map{{"kind", std::string("range")}, {"x_min", low}, {"x_max", high}}}, {"x_axis", property_map{{"kind", std::string("frequency")}, {"unit", std::string("Hz")}}}, {"sigmf", input}};
    if (input.contains("core:sample_start")) {
        if (input.contains("gr4:observation")) {
            throw std::invalid_argument("mixed sample and observation coordinates");
        }
        const auto     start = integer(input, "core:sample_start");
        constexpr auto max   = std::uint64_t(INT64_MAX);
        if (start > max) {
            throw std::invalid_argument("SigMF sample_start exceeds int64 range");
        }
        property_map y{{"kind", std::string("sample")}, {"recording_id", text(input, "gr4:recording_id")}, {"start", start}};
        if (input.contains("core:sample_count")) {
            const auto count = integer(input, "core:sample_count");
            if (count > max || (count && start > max - (count - 1))) {
                throw std::invalid_argument("SigMF sample interval exceeds int64 range");
            }
            y["count"] = count;
        }
        a["y_axis"]                                        = std::move(y);
        (*a.at("geometry").get_if<property_map>())["kind"] = std::string("rectangle");
    } else {
        if (input.contains("core:sample_count")) {
            throw std::invalid_argument("sample_count requires sample_start");
        }
        if (input.contains("gr4:observation")) {
            auto y                                             = object(input, "gr4:observation");
            y["kind"]                                          = std::string("observation");
            a["y_axis"]                                        = std::move(y);
            (*a.at("geometry").get_if<property_map>())["kind"] = std::string("rectangle");
        } else {
            throw std::invalid_argument("SigMF annotation requires sample_start or "
                                        "explicit observation extension");
        }
    }
    for (const auto* k : {"style", "metadata"}) {
        const auto extension = std::string("gr4:") + k;
        if (input.contains(extension)) {
            a[k] = object(input, extension);
        }
    }
    return a;
}
struct Config {
    // Optional generic retention priority: discard unprotected entries before
    // protected entries. Hard count/byte limits always remain authoritative.
    std::function<bool(const property_map&)> retention_priority;
    std::string                              run_namespace, producer_instance = "annotations";
    std::size_t                              max_items = 10000, max_bytes = 32 * 1024 * 1024, max_clients = 8, queue_bytes = 4 * 1024 * 1024, snapshot_bytes = 128 * 1024 * 1024;
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
    std::shared_ptr<const Transaction> snapshotTransaction() const {
        std::lock_guard lock(mutex);
        return snapshotLocked();
    }
    std::uint64_t publicationCursor() const {
        std::lock_guard lock(mutex);
        return cursor;
    }
    std::uint64_t capacityEvictions() const {
        std::lock_guard lock(mutex);
        return capacity_evicted;
    }
    using SubscriberType = Subscriber;

private:
    struct Entry {
        std::uint64_t                       revision = 0, order = 0;
        std::shared_ptr<const property_map> native;
        std::size_t                         accounted = 0;
        bool                                terminal  = false;
        bool                                deleted() const { return !native; }
        std::size_t                         bytes(const std::string& id) const { return 192 + 6 * id.size() + accounted; }
    };
    mutable std::mutex                     mutex;
    Config                                 config;
    std::map<std::string, Entry>           items;
    std::vector<std::weak_ptr<Subscriber>> subscribers;
    std::string                            stream_epoch = epoch(), last_error;
    std::uint64_t                          cursor = 0, evicted = 0, capacity_evicted = 0, dropped = 0, late = 0, duplicates = 0, conflicts = 0, overflows = 0, order = 0;
    std::optional<std::uint64_t>           batch;
    property_map                           last_batch_rows;
    std::size_t                            retained = 0;
    bool                                   fault    = false;
    std::string                            envelope(bool snapshot, std::uint64_t base = 0) const { return "{\"payload_format\":\"plot-annotations-json-v1\",\"message\":" + quote(snapshot ? "snapshot" : "delta") + ",\"scope\":{\"run_namespace\":" + quote(config.run_namespace) + ",\"producer_instance\":" + quote(config.producer_instance) + "},\"stream_epoch\":" + quote(stream_epoch) + ",\"cursor\":" + quote(std::to_string(cursor)) + ",\"retention\":{\"max_items\":" + std::to_string(config.max_items) + ",\"max_bytes\":" + std::to_string(config.max_bytes) + ",\"evicted_items\":" + quote(std::to_string(evicted)) + ",\"dropped_updates\":" + quote(std::to_string(dropped)) + (config.retention_priority ? ",\"capacity_evicted_items\":" + quote(std::to_string(capacity_evicted)) : "") + "}" + (snapshot ? "" : ",\"base_cursor\":" + quote(std::to_string(base))); }
    std::shared_ptr<const Transaction>     snapshotLocked() const {
        // Entries own immutable values: snapshot capture copies references,
        // keeping large metadata trees off the producer's critical section.
        auto captured = items;
        auto header   = envelope(true);
        auto encode   = [captured = std::move(captured), header = std::move(header)] {
            std::string values, dead;
            for (auto& [id, e] : captured) {
                auto& out = e.deleted() ? dead : values;
                if (!out.empty()) {
                    out += ',';
                }
                out += e.deleted() ? "{\"id\":" + quote(id) + ",\"revision\":" + quote(std::to_string(e.revision)) + "}" : json(*e.native);
            }
            return header + ",\"items\":[" + values + "],\"tombstones\":[" + dead + "]}";
        };
        return std::make_shared<Transaction>(Transaction{std::move(encode), retained + 4096, true});
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
            throw std::invalid_argument("invalid annotation limits/scope");
        }
        std::lock_guard lock(mutex);
        if (!preserveSubscribers) {
            for (auto& w : subscribers) {
                if (auto s = w.lock()) {
                    s->failed = true;
                }
            }
        }
        config = std::move(c);
        items.clear();
        retained = 0;
        cursor = evicted = capacity_evicted = dropped = late = duplicates = conflicts = overflows = order = 0;
        batch.reset();
        last_batch_rows.clear();
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
                throw std::invalid_argument("annotation stream faulted; fresh execution required");
            }
            if (d.extents.size() != 1 || d.extents[0] > 8192 || d.meta_information.size() != 1 || d.axis_names != std::vector<std::string>{"row_index"} || d.axis_units != std::vector<std::string>{"1"} || d.signal_names != std::vector<std::string>{"row_ordinal"} || d.signal_quantities != std::vector<std::string>{"ordinal"} || d.signal_units != std::vector<std::string>{"1"} || d.axis_values.size() != 1 || d.axis_values[0].size() != d.extents[0] || d.signal_values.size() != d.extents[0]) {
                throw std::invalid_argument("invalid native ordinal carrier");
            }
            auto& m       = d.meta_information[0];
            auto  version = m.at("contract_version").get_if<std::uint32_t>();
            if ((text(m, "kind") != "studio_annotations" && text(m, "kind") != "annotation_updates") || !version || *version != 1 || integer(m, "update_count") != d.extents[0]) {
                throw std::invalid_argument("invalid annotation contract");
            }
            auto& scope = object(m, "scope");
            if (text(scope, "run_namespace") != config.run_namespace || text(scope, "producer_instance") != config.producer_instance) {
                throw std::invalid_argument("scope mismatch");
            }
            auto  ordinal = integer(m, "producer_batch_ordinal");
            auto& rows    = object(m, "rows");
            if (rows.size() != d.extents[0]) {
                throw std::invalid_argument("invalid operation count");
            }
            if (batch && ordinal < *batch) {
                ++late;
                return false;
            }
            if (batch && ordinal == *batch) {
                if (rows == last_batch_rows) {
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
            bool                         cleared     = false;
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
                    auto a = normalize_annotation(object(r, "value"));
                    annotation(a, config.run_namespace);
                    op.id              = text(a, "annotation_id");
                    op.entry.revision  = integer(a, "revision");
                    op.entry.accounted = bound(a);
                    batch_bytes += op.entry.accounted;
                    if (batch_bytes > config.max_bytes) {
                        throw std::invalid_argument("native operation batch exceeds byte budget");
                    }
                    if (a.contains("style")) {
                        auto& s           = object(a, "style");
                        op.entry.terminal = s.contains("terminal") && *s.at("terminal").get_if<bool>();
                    }
                    op.entry.native = std::make_shared<const property_map>(std::move(a));
                } else if (operation == "delete") {
                    keys(r, {"operation", "annotation_id", "revision"});
                    op.id             = text(r, "annotation_id");
                    op.entry.revision = integer(r, "revision");
                } else {
                    throw std::invalid_argument("invalid operation");
                }
                if (op.entry.bytes(op.id) + 4096 > std::min(config.max_bytes, config.snapshot_bytes)) {
                    throw std::invalid_argument("annotation exceeds byte budget");
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
                        if ((!op.entry.native && !old->native) || (op.entry.native && old->native && *op.entry.native == *old->native)) {
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
                        throw std::invalid_argument("conflicting equal annotation revision");
                    }
                }
                touched[op.id] = op.entry;
                op.event       = r;
                if (operation == "upsert") {
                    op.event["value"] = *op.entry.native;
                }
                ops.push_back(std::move(op));
            }
            auto next_batch_rows = rows;
            // All operations validated before changing authoritative state. One
            // bounded transaction per operation.
            for (auto& op : ops) {
                if (cursor == UINT64_MAX || order == UINT64_MAX) {
                    throw std::overflow_error("annotation cursor exhausted");
                }
                auto        base  = cursor++;
                bool        reset = false;
                std::string removed;
                if (op.clear) {
                    items.clear();
                    retained = 0;
                } else {
                    auto it = items.find(op.id);
                    if (it != items.end()) {
                        retained -= it->second.bytes(it->first);
                    }
                    op.entry.order = ++order;
                    items[op.id]   = op.entry;
                    retained += op.entry.bytes(op.id);
                }
                // Count includes bounded tombstones. First discard entries outside
                // the caller's retained history, then terminal/oldest entries.
                auto protectedEntry = [&](const Entry& entry) { return !entry.deleted() && config.retention_priority && config.retention_priority(*entry.native); };
                while (items.size() > config.max_items || retained + 4096 > std::min(config.max_bytes, config.snapshot_bytes)) {
                    auto victim = items.end();
                    for (auto it = items.begin(); it != items.end(); ++it) {
                        if (victim == items.end() || std::tuple{protectedEntry(it->second), !it->second.terminal, it->second.order} < std::tuple{protectedEntry(victim->second), !victim->second.terminal, victim->second.order}) {
                            victim = it;
                        }
                    }
                    if (victim == items.end()) {
                        break;
                    }
                    if (protectedEntry(victim->second)) {
                        ++capacity_evicted;
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
                if (reset) {
                    stream_epoch = epoch();
                    publish(snapshotLocked());
                } else {
                    auto header = envelope(false, base);
                    auto event  = std::move(op.event);
                    auto bytes  = bound(event) + 4096 + removed.size();
                    auto encode = [header = std::move(header), event = std::move(event), removed = std::move(removed)] { return header + ",\"events\":[" + json(event) + "],\"evicted_ids\":[" + removed + "]}"; };
                    publish(std::make_shared<Transaction>(Transaction{std::move(encode), bytes, false}));
                }
            }
            last_batch_rows = std::move(next_batch_rows);
            batch           = ordinal;
            return true;
        } catch (const std::exception& e) {
            last_error = e.what();
            dropped += std::max<std::uint64_t>(1, d.extents.size() == 1 && d.extents[0] >= 0 ? std::min<std::uint64_t>(d.extents[0], 8192) : 1);
            return false;
        }
    }
};
} // namespace gr::studio::annotations
