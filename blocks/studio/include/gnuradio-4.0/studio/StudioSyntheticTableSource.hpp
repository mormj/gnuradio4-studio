// SPDX-License-Identifier: MIT
#pragma once
#include <gnuradio-4.0/Block.hpp>
#include <gnuradio-4.0/BlockRegistry.hpp>
#include <gnuradio-4.0/studio/StudioTableStore.hpp>
#include <thread>
namespace gr::studio {
GR_REGISTER_BLOCK("gr::studio::SyntheticTableSource", gr::studio::SyntheticTableSource)
struct SyntheticTableSource : Block<SyntheticTableSource> {
    using Block<SyntheticTableSource>::Block;
    PortOut<DataSet<double>> out;
    std::string              run_namespace, producer_instance = "tables0", annotation_producer = "annotations0";
    std::uint32_t            interval_ms = 470, initial_delay_ms = 0, unique_rows = 2, total_updates = 9;
    GR_MAKE_REFLECTABLE(SyntheticTableSource, out, run_namespace, producer_instance, annotation_producer, interval_ms, initial_delay_ms, unique_rows, total_updates);
    std::uint64_t emitted = 0;
    void          start() {
        if (run_namespace.empty() || !unique_rows || unique_rows > 10000 || total_updates < unique_rows || total_updates > 1000000) {
            throw gr::exception("Synthetic table requires execution namespace");
        }
        emitted = 0;
    }
    static property_map schema() {
        property_map columns;
        auto         add = [&](std::string key, std::string type, std::string unit = "", bool nullable = false) {
            property_map c{{"key", key}, {"label", key}, {"type", type}, {"nullable", nullable}};
            if (!unit.empty()) {
                c["unit"] = unit;
            }
            columns[std::pmr::string(std::to_string(columns.size()))] = std::move(c);
        };
        add("identity", "uint64");
        add("frequency", "float64", "Hz");
        add("power", "float64", "dBm");
        add("state", "string");
        add("offset", "int64");
        add("confirmed", "boolean");
        add("reason", "string", "", true);
        return columns;
    }
    DataSet<double> next() {
        // Independent timing; same exact annotation namespace and identity as
        // stream fixture.
        static constexpr int         region[] = {0, 0, 1, 0, 1, 0, 0, 1, 0};
        static constexpr const char* state[]  = {"created", "confirmed", "created", "updated", "confirmed", "coasting", "updated", "closed", "closed"};
        const auto                   i        = std::min<std::uint64_t>(emitted, 8);
        auto                         identity = std::uint64_t(9007199254740993ULL + (unique_rows == 2 ? region[i] : emitted % unique_rows));
        auto                         id       = "[" + tables::quote(run_namespace) + "," + tables::quote(annotation_producer) + ",\"1\",\"" + std::to_string(identity) + "\"]";
        property_map                 rows;
        if (emitted < total_updates) {
            const std::string lifecycle = unique_rows == 2 ? state[i] : emitted + unique_rows >= total_updates ? "closed" : "updated";
            property_map      values{{"identity", identity}, {"frequency", 902000140.1234567 + 300.0 * region[i]}, {"power", -41.0 + double(i) / 4}, {"state", lifecycle}, {"offset", std::int64_t(INT64_MIN)}, {"confirmed", i > 0}};
            if (i >= 7) {
                values["reason"] = std::string("fixture complete");
            } else {
                values["reason"] = gr::pmt::Value{};
            }
            property_map row{{"row_id", id}, {"annotation_id", id}, {"revision", std::uint64_t(emitted + 1)}, {"terminal", unique_rows == 2 ? i >= 7 : emitted + unique_rows >= total_updates}, {"values", std::move(values)}};
            rows["0"] = property_map{{"operation", std::string("upsert")}, {"value", std::move(row)}};
        }
        DataSet<double> d;
        d.extents           = {rows.empty() ? 0 : 1};
        d.axis_names        = {"row_index"};
        d.axis_units        = {"1"};
        d.axis_values       = {rows.empty() ? std::vector<double>{} : std::vector<double>{0.0}};
        d.signal_names      = {"row_ordinal"};
        d.signal_quantities = {"ordinal"};
        d.signal_units      = {"1"};
        d.signal_values     = d.axis_values[0];
        d.meta_information  = {property_map{{"kind", std::string("studio_table_updates")}, {"contract_version", std::uint32_t(1)}, {"scope", property_map{{"run_namespace", run_namespace}, {"producer_instance", producer_instance}}}, {"columns", schema()}, {"update_count", std::uint64_t(rows.size())}, {"producer_batch_ordinal", emitted}, {"rows", std::move(rows)}}};
        if (emitted == UINT64_MAX) {
            throw gr::exception("synthetic table ordinal exhausted");
        }
        ++emitted;
        return d;
    }
    [[nodiscard]] work::Status processBulk(gr::OutputSpanLike auto& output) {
        if (output.empty()) {
            return work::Status::OK;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(emitted == 0 && initial_delay_ms ? initial_delay_ms : interval_ms));
        output[0] = next();
        output.publish(1);
        return work::Status::OK;
    }
};
} // namespace gr::studio
