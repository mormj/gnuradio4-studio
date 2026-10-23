// SPDX-License-Identifier: MIT
#pragma once
#include <chrono>
#include <gnuradio-4.0/Block.hpp>
#include <gnuradio-4.0/BlockRegistry.hpp>
#include <gnuradio-4.0/DataSet.hpp>
#include <gnuradio-4.0/studio/StudioDataSetWaterfallStore.hpp>
#include <thread>
namespace gr::studio {
GR_REGISTER_BLOCK("gr::studio::SyntheticAnnotationSource", gr::studio::SyntheticAnnotationSource)
struct SyntheticAnnotationSource : Block<SyntheticAnnotationSource> {
    using Block<SyntheticAnnotationSource>::Block;
    PortOut<DataSet<double>> out;
    std::string              run_namespace, producer_instance = "annotations0", source_epoch;
    std::uint64_t            first_sequence = 9007199254740993ULL;
    std::uint32_t            interval_ms    = 350;
    GR_MAKE_REFLECTABLE(SyntheticAnnotationSource, out, run_namespace, producer_instance, source_epoch, first_sequence, interval_ms);
    std::uint64_t emitted = 0;
    void          start() {
        if (run_namespace.empty() || source_epoch.empty()) {
            throw gr::exception("Synthetic annotations require explicit execution "
                                "namespace/source epoch");
        }
        emitted = 0;
    }
    property_map    key(std::uint64_t offset) const { return {{"run_namespace", run_namespace}, {"source_id", std::string("synthetic")}, {"acquisition_id", std::string("replay")}, {"source_epoch", source_epoch}, {"sequence", std::uint64_t(first_sequence + offset)}}; }
    DataSet<double> next() {
        // Two interleaved lifecycles. Coasting and close do not move last support.
        static constexpr int           region[]  = {0, 0, 1, 0, 1, 0, 0, 1, 0};
        static constexpr const char*   state[]   = {"TENTATIVE", "ACTIVE", "TENTATIVE", "ACTIVE", "ACTIVE", "COASTING", "ACTIVE", "CLOSED", "CLOSED"};
        static constexpr std::uint64_t support[] = {1, 4, 3, 9, 12, 9, 18, 12, 18};
        const auto                     index     = std::min<std::uint64_t>(emitted, 8);
        const int                      r         = region[index];
        const auto                     id        = "[" + dataset_waterfall::quote(run_namespace) + "," + dataset_waterfall::quote(producer_instance) + ",\"1\",\"" + (r ? "9007199254740994" : "9007199254740993") + "\"]";
        property_map                   a{{"annotation_id", id}, {"revision", std::uint64_t(emitted + 1)}, {"geometry", property_map{{"kind", std::string("rectangle")}, {"x_min", 902000100.1234567 + double(r) * 300}, {"x_max", 902000180.1234567 + double(r) * 300 + double(support[index]) * 4}}}, {"x_axis", property_map{{"kind", std::string("frequency")}, {"unit", std::string("Hz")}}}, {"y_axis", property_map{{"kind", std::string("observation")}, {"first", key(r ? 2 : 0)}, {"last", key(support[index])}}}, {"label", std::string(r ? "Region B" : "Region A")}, {"style", property_map{{"state", std::string(state[index])}, {"terminal", index >= 7}}}};
        DataSet<double>                d;
        d.extents           = {1};
        d.axis_names        = {"row_index"};
        d.axis_units        = {"1"};
        d.axis_values       = {{0.0}};
        d.signal_names      = {"row_ordinal"};
        d.signal_quantities = {"ordinal"};
        d.signal_units      = {"1"};
        d.signal_values     = {0.0};
        d.meta_information  = {property_map{{"kind", std::string("studio_annotations")}, {"contract_version", std::uint32_t(1)}, {"update_count", std::uint64_t(1)}, {"producer_batch_ordinal", emitted}, {"scope", property_map{{"run_namespace", run_namespace}, {"producer_instance", producer_instance}}}, {"rows", property_map{{"0", property_map{{"operation", std::string("upsert")}, {"value", std::move(a)}}}}}}};
        ++emitted;
        return d;
    }
    [[nodiscard]] work::Status processBulk(gr::OutputSpanLike auto& output) {
        if (output.empty()) {
            return work::Status::OK;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
        if (emitted < 9) {
            output[0] = next();
        } else {
            if (emitted == UINT64_MAX) {
                throw gr::exception("synthetic batch ordinal exhausted");
            }
            DataSet<double> d;
            d.extents           = {0};
            d.axis_names        = {"row_index"};
            d.axis_units        = {"1"};
            d.axis_values       = {{}};
            d.signal_names      = {"row_ordinal"};
            d.signal_quantities = {"ordinal"};
            d.signal_units      = {"1"};
            d.meta_information  = {property_map{{"kind", std::string("studio_annotations")}, {"contract_version", std::uint32_t(1)}, {"update_count", std::uint64_t(0)}, {"producer_batch_ordinal", emitted++}, {"scope", property_map{{"run_namespace", run_namespace}, {"producer_instance", producer_instance}}}, {"rows", property_map{}}}};
            output[0]           = std::move(d);
        }
        output.publish(1);
        return work::Status::OK;
    }
};
} // namespace gr::studio
