// SPDX-License-Identifier: MIT
#pragma once
#include <chrono>
#include <gnuradio-4.0/Block.hpp>
#include <gnuradio-4.0/BlockRegistry.hpp>
#include <gnuradio-4.0/DataSet.hpp>
#include <thread>

namespace gr::studio {
GR_REGISTER_BLOCK("gr::studio::SyntheticSpectrumSource", gr::studio::SyntheticSpectrumSource)
// Deterministic stream replay fixture. Values and sequence are synthetic; no RF
// time is asserted.
struct SyntheticSpectrumSource : Block<SyntheticSpectrumSource> {
    using Block<SyntheticSpectrumSource>::Block;
    PortOut<DataSet<double>> out;
    gr::Size_t               bins           = 6817;
    std::uint64_t            first_sequence = 9007199254740993ULL;
    std::uint64_t            finite_frames  = 0;
    std::uint32_t            interval_ms    = 100;
    GR_MAKE_REFLECTABLE(SyntheticSpectrumSource, out, bins, first_sequence, finite_frames, interval_ms);
    std::uint64_t emitted = 0;
    void          start() {
        if (bins < 1 || bins > 1048576) {
            throw gr::exception("invalid synthetic bin count");
        }
        emitted = 0;
    }
    [[nodiscard]] work::Status processBulk(gr::OutputSpanLike auto& output) {
        if (finite_frames && emitted >= finite_frames) {
            output.publish(0);
            return work::Status::DONE;
        }
        if (output.empty()) {
            return work::Status::OK;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
        DataSet<double> d;
        d.extents    = {static_cast<std::int32_t>(bins)};
        d.axis_names = {"frequency"};
        d.axis_units = {"Hz"};
        d.axis_values.resize(1);
        d.signal_names      = {"synthetic spectrum"};
        d.signal_quantities = {"power"};
        d.signal_units      = {"dBm"};
        for (std::size_t i = 0; i < bins; ++i) {
            d.axis_values[0].push_back(902000000.1234567 + 0.125 * double(i));
            d.signal_values.push_back(-100.0 + double((i + emitted) % 41));
        }
        d.meta_information = {property_map{{"source_id", std::string("synthetic")}, {"acquisition_id", std::string("replay")}, {"sequence", std::uint64_t(first_sequence + emitted)}, {"coordinate_model", std::string("uniform_inclusive_actual_endpoints")}, {"timestamp_provenance", std::string("unknown")}}};
        output[0]          = std::move(d);
        output.publish(1);
        ++emitted;
        return work::Status::OK;
    }
};
} // namespace gr::studio
