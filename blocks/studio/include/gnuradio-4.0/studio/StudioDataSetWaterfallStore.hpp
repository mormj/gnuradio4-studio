// SPDX-License-Identifier: MIT
#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <deque>
#include <gnuradio-4.0/DataSet.hpp>
#include <iomanip>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>

namespace gr::studio::dataset_waterfall {
inline std::string quote(std::string_view s) {
    std::ostringstream o;
    o << '"';
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') {
            o << '\\' << c;
        } else if (c < 32) {
            o << "\\u" << std::hex << std::setw(4) << std::setfill('0') << unsigned(c) << std::dec;
        } else {
            o << c;
        }
    }
    o << '"';
    return o.str();
}
inline std::string epoch() {
    static std::atomic_uint64_t counter{0};
    static const auto           seed = std::random_device{}();
    return std::to_string(seed) + "-" + std::to_string(++counter);
}
struct Config {
    bool        source_identity_from_data = false;
    std::size_t signal_index = 0, axis_index = 0, max_rows = 256, max_bytes = 64 * 1024 * 1024;
    std::size_t annotation_max_items = 10000, annotation_max_bytes = 64 * 1024 * 1024;
    std::size_t max_clients = 8, queue_bytes = 4 * 1024 * 1024, snapshot_bytes = 128 * 1024 * 1024;
    std::string run_namespace, source_epoch, producer_instance                 = "waterfall";
    std::string source_epoch_key; // Optional native epoch string, scoped by
                                  // run_namespace.
    std::string source_key = "source_id", acquisition_key = "acquisition_id", sequence_key = "sequence";
    std::string model_key = "coordinate_model", provenance_key = "timestamp_provenance", raw_time_key = "timestamp_raw_text", unix_ns_key = "timestamp_unix_ns";
    std::string validity_key = "validity", coverage_key = "coverage";
};
struct Row {
    std::string                 run, source, acquisition, source_epoch, grid, provenance = "unknown", raw, validity = "schema_valid", coverage = "reported_bin_vector";
    std::uint64_t               sequence = 0;
    std::optional<std::int64_t> unix_ns;
    std::vector<double>         power;
    bool                        gap = false, reset = false;
    std::string                 key() const { return "{\"run_namespace\":" + quote(run) + ",\"source_id\":" + quote(source) + ",\"acquisition_id\":" + quote(acquisition) + ",\"source_epoch\":" + quote(source_epoch) + ",\"sequence\":" + quote(std::to_string(sequence)) + "}"; }
    bool                        operator==(const Row&) const = default;
    std::size_t                 bytes() const { return sizeof(Row) + power.size() * sizeof(double) + run.size() + source.size() + acquisition.size() + source_epoch.size() + grid.size() + provenance.size() + raw.size() + validity.size() + coverage.size(); }
    // Conservative encoded bound, including worst-case escaping and max_digits10
    // doubles.
    std::size_t encodedBound() const { return 1024 + power.size() * 32 + 6 * (run.size() + source.size() + acquisition.size() + source_epoch.size() + grid.size() + provenance.size() + raw.size() + validity.size() + coverage.size()); }
    std::string json() const {
        std::ostringstream o;
        o.imbue(std::locale::classic());
        o << std::setprecision(17);
        o << "{\"frame_key\":" << key() << ",\"grid_id\":" << quote(grid) << ",\"power\":[";
        for (std::size_t i = 0; i < power.size(); ++i) {
            if (i) {
                o << ',';
            }
            o << power[i];
        }
        o << "],\"timestamp\":{\"unix_ns\":" << (unix_ns ? quote(std::to_string(*unix_ns)) : "null") << ",\"provenance\":" << quote(provenance) << ",\"raw_text\":" << quote(raw) << "},\"validity\":" << quote(validity) << ",\"coverage\":" << quote(coverage) << ",\"discontinuities\":[" << (reset ? "\"grid_or_partition_reset\"" : gap ? "\"source_sequence_gap\"" : "") << "]}";
        return o.str();
    }
};
struct Grid {
    std::string         id, model, unit;
    std::vector<double> x;
    std::string         json() const {
        std::ostringstream o;
        o.imbue(std::locale::classic());
        o << std::setprecision(17);
        o << "{\"grid_id\":" << quote(id) << ",\"axis\":\"frequency\",\"unit\":\"Hz\",\"coordinate_model\":" << quote(model) << ",\"power_unit\":" << quote(unit) << ",\"coordinates\":[";
        for (std::size_t i = 0; i < x.size(); ++i) {
            if (i) {
                o << ',';
            }
            o << x[i];
        }
        o << "]}";
        return o.str();
    }
};
struct Transaction {
    Config                                  config;
    std::string                             stream_epoch, reset_reason;
    std::uint64_t                           base = 0, cursor = 0, evicted = 0, dropped = 0;
    bool                                    snapshot = false;
    std::shared_ptr<const Grid>             grid;
    std::vector<std::shared_ptr<const Row>> rows, removals;
    std::size_t                             bound = 0;
    std::string                             json() const {
        std::ostringstream o;
        o << "{\"payload_format\":\"dataset-waterfall-json-v1\",\"scope\":{\"run_"
             "namespace\":"
          << quote(config.run_namespace) << ",\"producer_instance\":" << quote(config.producer_instance) << "},\"stream_epoch\":" << quote(stream_epoch) << ",\"cursor\":" << quote(std::to_string(cursor)) << ",\"message\":" << quote(snapshot ? "snapshot" : "delta") << ",\"retention\":{\"max_items\":" << config.max_rows << ",\"max_bytes\":" << config.max_bytes << ",\"evicted_items\":" << quote(std::to_string(evicted)) << ",\"dropped_updates\":" << quote(std::to_string(dropped)) << '}';
        if (snapshot) {
            o << ",\"grids\":[";
            if (grid) {
                o << grid->json();
            }
            o << ']';
        } else {
            o << ",\"base_cursor\":" << quote(std::to_string(base)) << ",\"evicted_frame_keys\":[";
            for (std::size_t i = 0; i < removals.size(); ++i) {
                if (i) {
                    o << ',';
                }
                o << removals[i]->key();
            }
            o << ']';
        }
        o << ",\"rows\":[";
        for (std::size_t i = 0; i < rows.size(); ++i) {
            if (i) {
                o << ',';
            }
            o << rows[i]->json();
        }
        o << "]}";
        return o.str();
    }
};
struct Subscriber {
    std::deque<std::shared_ptr<const Transaction>> pending;
    std::size_t                                    bytes = 0, delta_bytes = 0;
    bool                                           failed = false;
};
class Store {
    mutable std::mutex                     mutex;
    Config                                 config;
    std::shared_ptr<const Grid>            grid;
    std::deque<std::shared_ptr<const Row>> rows;
    std::vector<std::weak_ptr<Subscriber>> subscribers;
    std::string                            stream_epoch = epoch(), reset_reason;
    std::uint64_t                          cursor = 0, evicted = 0, dropped = 0;
    std::size_t                            retained = 0;
    bool                                   fault    = false;
    std::string                            last_error;
    static std::string                     str(const property_map& m, const std::string& key, std::string fallback = "") {
        auto i = m.find(key);
        if (i == m.end()) {
            return fallback;
        }
        if (auto s = i->second.get_if<std::pmr::string>()) {
            if (s->size() > 4096) {
                throw std::invalid_argument("oversized selected metadata");
            }
            return std::string(*s);
        }
        throw std::invalid_argument("metadata selector requires string: " + key);
    }
    static void bounded(const std::string& s, std::size_t max = 512) {
        if (s.empty() || s.size() > max) {
            throw std::invalid_argument("missing or oversized metadata");
        }
    }
    Transaction envelope(bool snapshot) const {
        Transaction t;
        t.config       = config;
        t.stream_epoch = stream_epoch;
        t.cursor       = cursor;
        t.evicted      = evicted;
        t.dropped      = dropped;
        t.snapshot     = snapshot;
        t.reset_reason = reset_reason;
        return t;
    }
    std::shared_ptr<const Transaction> snapshotLocked() const {
        auto t  = std::make_shared<Transaction>(envelope(true));
        t->grid = grid;
        t->rows.assign(rows.begin(), rows.end());
        t->bound = 8192 + (grid ? grid->x.size() * 32 + 8192 : 0);
        for (auto& r : rows) {
            t->bound += r->encodedBound();
        }
        return t;
    }
    void publish(std::shared_ptr<const Transaction> t) {
        std::erase_if(subscribers, [](auto& w) { return w.expired(); });
        for (auto& w : subscribers) {
            if (auto s = w.lock(); s && !s->failed) {
                const auto limit = t->snapshot ? config.snapshot_bytes : config.queue_bytes;
                if (t->bound > limit || (t->snapshot ? s->bytes + t->bound > config.snapshot_bytes + config.queue_bytes : s->delta_bytes + t->bound > config.queue_bytes)) {
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
    std::uint64_t publicationCursor() const {
        std::lock_guard lock(mutex);
        return cursor;
    }
    std::uint64_t invalid = 0, duplicates = 0, late = 0, conflicts = 0, overflows = 0;
    void          configure(Config c) {
        if (c.max_rows < 1 || c.max_rows > 2048 || c.max_bytes < 1024 || c.max_bytes > 128 * 1024 * 1024 || c.snapshot_bytes > 128 * 1024 * 1024 || c.queue_bytes > 128 * 1024 * 1024 || c.max_clients < 1 || c.max_clients > 64 || c.queue_bytes < 1024 || c.snapshot_bytes < 1024) {
            throw std::invalid_argument("invalid waterfall limits");
        }
        for (const auto* selector : {&c.source_key, &c.acquisition_key, &c.sequence_key, &c.model_key, &c.provenance_key, &c.raw_time_key, &c.unix_ns_key, &c.validity_key, &c.coverage_key}) {
            bounded(*selector);
        }
        bounded(c.run_namespace);
        bounded(c.source_epoch);
        bounded(c.producer_instance);
        std::lock_guard lock(mutex);
        config = std::move(c);
        rows.clear();
        grid.reset();
        retained = 0;
        cursor   = 0;
        evicted  = 0;
        dropped  = 0;
        fault    = false;
        last_error.clear();
        stream_epoch = epoch();
        reset_reason = "execution_start";
        for (auto& w : subscribers) {
            if (auto s = w.lock()) {
                s->failed = true;
            }
        }
        subscribers.clear();
        invalid = duplicates = late = conflicts = overflows = 0;
    }
    std::shared_ptr<Subscriber> subscribe() {
        std::lock_guard lock(mutex);
        std::erase_if(subscribers, [](auto& w) { return w.expired(); });
        if (subscribers.size() >= config.max_clients || fault) {
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
    std::shared_ptr<const Transaction> snapshot() const {
        std::lock_guard lock(mutex);
        return snapshotLocked();
    }
    std::array<std::uint64_t, 5> diagnostics() const {
        std::lock_guard lock(mutex);
        return {invalid, duplicates, late, conflicts, overflows};
    }
    std::string lastError() const {
        std::lock_guard lock(mutex);
        return last_error;
    }
    bool push(const DataSet<double>& d) {
        std::lock_guard lock(mutex);
        try {
            if (fault) {
                ++dropped;
                return false;
            }
            const auto si = config.signal_index, ai = config.axis_index;
            if (d.extents.size() != 1 || d.extents[0] <= 0 || ai >= d.axis_values.size() || ai >= d.axis_units.size() || si >= d.signal_names.size() || si >= d.signal_units.size() || si >= d.meta_information.size()) {
                throw std::invalid_argument("invalid spectrum dimensions");
            }
            const auto n = static_cast<std::size_t>(d.extents[0]);
            if (n > 1048576 || d.axis_values[ai].size() != n || d.signal_values.size() != n * d.signal_names.size() || d.axis_units[ai] != "Hz") {
                throw std::invalid_argument("invalid coordinates or frequency unit");
            }
            bounded(d.signal_units[si]);
            constexpr std::string_view powerUnits[] = {"W", "mW", "uW", "nW", "pW", "dBW", "dBm", "dBuW", "dB"};
            if (si >= d.signal_quantities.size()) {
                throw std::invalid_argument("missing power quantity");
            }
            const auto& quantity    = d.signal_quantities[si];
            const auto& unit        = d.signal_units[si];
            const bool  absolute    = quantity == "power" && std::ranges::find(powerUnits, unit) != std::end(powerUnits);
            const bool  relative    = quantity == "relative digital power" && (unit == "digital power" || unit == "dB re 1 digital power");
            const bool  relativePsd = quantity == "relative digital power spectral density" && unit == "digital power/Hz";
            if (!absolute && !relative && !relativePsd) {
                throw std::invalid_argument("unsupported power quantity/unit");
            }
            const auto& x = d.axis_values[ai];
            auto        y = d.signalValues(si);
            if (y.size() != n) {
                throw std::invalid_argument("invalid signal shape");
            }
            const double step = n > 1 ? (x.back() - x.front()) / double(n - 1) : 0;
            for (std::size_t i = 0; i < n; ++i) {
                if (!std::isfinite(x[i]) || !std::isfinite(y[i]) || (i && x[i] <= x[i - 1])) {
                    throw std::invalid_argument("nonfinite or reversed spectrum");
                }
                const double expected  = x.front() + step * double(i);
                const double tolerance = std::max(std::abs(step) * 1e-7, std::abs(expected) * std::numeric_limits<double>::epsilon() * 8);
                if (std::abs(x[i] - expected) > tolerance) {
                    throw std::invalid_argument("irregular frequency grid");
                }
            }
            const auto& m   = d.meta_information[si];
            auto        r   = std::make_shared<Row>();
            r->run          = config.run_namespace;
            r->source_epoch = config.source_epoch;
            if (auto it = m.find("gr4:observation"); config.source_identity_from_data && it != m.end()) {
                const auto* key = it->second.get_if<property_map>();
                if (!key) {
                    throw std::invalid_argument("invalid observation reference");
                }
                r->run          = str(*key, "run_namespace");
                r->source_epoch = str(*key, "source_epoch");
                r->source       = str(*key, "source_id");
                r->acquisition  = str(*key, "acquisition_id");
                for (const auto* value : {&r->run, &r->source_epoch, &r->source, &r->acquisition}) {
                    bounded(*value);
                }
                auto seq = key->find("sequence");
                if (seq == key->end() || !seq->second.get_if<std::uint64_t>()) {
                    throw std::invalid_argument("observation sequence requires native uint64");
                }
                r->sequence   = *seq->second.get_if<std::uint64_t>();
                auto selected = m.find(config.sequence_key);
                if (selected != m.end() && (!selected->second.get_if<std::uint64_t>() || *selected->second.get_if<std::uint64_t>() != r->sequence)) {
                    throw std::invalid_argument("conflicting source observation sequence");
                }
            } else {
                if (!config.source_epoch_key.empty()) {
                    auto nativeEpoch = str(m, config.source_epoch_key);
                    bounded(nativeEpoch);
                    r->source_epoch = config.run_namespace + "/" + nativeEpoch;
                    bounded(r->source_epoch);
                }
                r->source      = str(m, config.source_key);
                r->acquisition = str(m, config.acquisition_key);
                bounded(r->source);
                bounded(r->acquisition);
                auto seq = m.find(config.sequence_key);
                if (seq == m.end() || !seq->second.get_if<std::uint64_t>()) {
                    throw std::invalid_argument("sequence requires native uint64");
                }
                r->sequence = *seq->second.get_if<std::uint64_t>();
            }
            r->provenance = str(m, config.provenance_key, "unknown");
            bounded(r->provenance);
            r->raw = str(m, config.raw_time_key);
            if (r->raw.size() > 4096) {
                throw std::invalid_argument("oversized timestamp");
            }
            if (config.unix_ns_key == "$dataset.timestamp" && d.timestamp != 0) {
                if (r->provenance == "unknown" || r->provenance == "unavailable" || r->provenance == "device_unzoned") {
                    throw std::invalid_argument("unqualified dataset timestamp");
                }
                r->unix_ns = d.timestamp;
            } else if (auto t = m.find(config.unix_ns_key); t != m.end()) {
                if (!t->second.get_if<std::int64_t>() || r->provenance == "unknown" || r->provenance == "device_unzoned") {
                    throw std::invalid_argument("unqualified timestamp");
                }
                r->unix_ns = *t->second.get_if<std::int64_t>();
            }
            r->validity = str(m, config.validity_key, "schema_valid");
            r->coverage = str(m, config.coverage_key, "reported_bin_vector");
            bounded(r->validity);
            bounded(r->coverage);
            auto model = str(m, config.model_key);
            bounded(model);
            bool reset = !grid || grid->x != x || grid->unit != d.signal_units[si] || grid->model != model;
            if (!rows.empty() && (rows.back()->run != r->run || rows.back()->source_epoch != r->source_epoch || rows.back()->source != r->source || rows.back()->acquisition != r->acquisition)) {
                reset = true;
            }
            auto nextGrid = grid;
            if (reset) {
                nextGrid = std::make_shared<Grid>(Grid{epoch(), model, d.signal_units[si], x});
            }
            r->grid = nextGrid->id;
            r->power.assign(y.begin(), y.end());
            if (r->bytes() + x.size() * sizeof(double) > config.max_bytes || r->encodedBound() + x.size() * 32 + 16384 > config.snapshot_bytes) {
                throw std::invalid_argument("row exceeds retention/serialization budget");
            }
            if (!rows.empty() && r->run == rows.back()->run && r->source_epoch == rows.back()->source_epoch && r->source == rows.back()->source && r->acquisition == rows.back()->acquisition && r->sequence <= rows.back()->sequence) {
                auto old = std::ranges::find_if(rows, [&](auto& a) { return a->sequence == r->sequence; });
                if (old != rows.end()) {
                    r->gap   = (*old)->gap;
                    r->reset = (*old)->reset;
                    if (**old == *r) {
                        ++duplicates;
                        return false;
                    }
                    ++conflicts;
                    fault      = true;
                    last_error = "conflicting frame identity; restart execution";
                    for (auto& w : subscribers) {
                        if (auto s = w.lock()) {
                            s->failed = true;
                            s->pending.clear();
                            s->bytes = 0;
                        }
                    }
                } else {
                    ++late;
                }
                ++dropped;
                return false;
            }
            const auto base = cursor;
            r->reset        = reset;
            if (reset) {
                config.run_namespace = r->run;
                config.source_epoch  = r->source_epoch;
                evicted += rows.size();
                rows.clear();
                retained     = x.size() * sizeof(double);
                grid         = nextGrid;
                stream_epoch = epoch();
                cursor       = 0;
                reset_reason = "grid_or_partition_change";
            } else if (!rows.empty() && r->sequence - rows.back()->sequence > 1) {
                r->gap = true;
            }
            rows.push_back(r);
            retained += r->bytes();
            auto t   = std::make_shared<Transaction>(envelope(false));
            t->base  = base;
            t->rows  = {r};
            t->bound = r->encodedBound() + 8192;
            while (rows.size() > config.max_rows || retained > config.max_bytes) {
                auto old = rows.front();
                rows.pop_front();
                retained -= old->bytes();
                t->removals.push_back(old);
                t->bound += 4096;
                ++evicted;
            }
            // Bound the complete serialized snapshot independently of native memory.
            auto bound = [&] {
                std::size_t b = 16384 + grid->x.size() * 32;
                for (auto& row : rows) {
                    b += row->encodedBound();
                }
                return b;
            };
            while (rows.size() > 1 && bound() > config.snapshot_bytes) {
                auto old = rows.front();
                rows.pop_front();
                retained -= old->bytes();
                t->removals.push_back(old);
                t->bound += 4096;
                ++evicted;
            }
            if (cursor == UINT64_MAX) {
                throw std::overflow_error("publication cursor exhausted");
            }
            ++cursor;
            if (reset) {
                publish(snapshotLocked());
            } else {
                t->cursor  = cursor;
                t->evicted = evicted;
                publish(t);
            }
            return true;
        } catch (const std::invalid_argument& e) {
            last_error = e.what();
            ++invalid;
            ++dropped;
            return false;
        }
    }
};
} // namespace gr::studio::dataset_waterfall
