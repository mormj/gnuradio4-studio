#ifndef GNURADIO_STUDIO_CAPABILITIES_HPP
#define GNURADIO_STUDIO_CAPABILITIES_HPP

#include <gnuradio-4.0/Tag.hpp>
#include <gnuradio-4.0/annotated.hpp>

namespace gr::studio::detail {

// Version 1 uses the existing session stream protocol's transport/endpoint parameter convention.
template<meta::fixed_string Family, meta::fixed_string Payload, meta::fixed_string Count,
    meta::fixed_string Semantic, bool SampleRate, meta::fixed_string... Transports>
struct StudioVisualization {
    static void exportMetadata(auto&& emit) {
        property_map roles{{"transport", "transport"}, {"endpoint", "endpoint"},
            {"topic", "topic"}, {"updateMs", "update_ms"}};
        if constexpr (!Count.empty()) roles["seriesCount"] = std::string(std::string_view(Count));
        if constexpr (SampleRate) roles["sampleRate"] = std::string("sample_rate");
        emit("studio:visualization", property_map{{"version", std::uint32_t(1)},
            {"family", std::string(std::string_view(Family))}, {"payload_format", std::string(std::string_view(Payload))},
            {"semantic_kind", std::string(std::string_view(Semantic))}, {"routing", "session"},
            {"supported_transports", std::vector<std::string>{std::string(std::string_view(Transports))...}},
            {"parameters", std::move(roles)}});
    }
};

} // namespace gr::studio::detail

#endif
