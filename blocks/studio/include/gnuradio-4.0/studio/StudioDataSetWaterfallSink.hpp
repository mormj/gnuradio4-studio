// SPDX-License-Identifier: MIT
#pragma once
#include <gnuradio-4.0/Block.hpp>
#include <gnuradio-4.0/BlockRegistry.hpp>
#include <gnuradio-4.0/studio/StudioAnnotatedWaterfallStore.hpp>
#include <gnuradio-4.0/studio/StudioDataSetSink.hpp>
#include <gnuradio-4.0/studio/StudioIncrementalWebSocket.hpp>
namespace gr::studio {
GR_REGISTER_BLOCK("gr::studio::StudioDataSetWaterfallSink", gr::studio::StudioDataSetWaterfallSink, [T], [double])
template<typename T>
struct StudioDataSetWaterfallSink : Block<StudioDataSetWaterfallSink<T>> {
    static_assert(std::same_as<T, double>);
    using Description = Doc<"Native spectra and optional generic SigMF-compatible annotation "
                            "input; one bounded ordered dataset-waterfall-json-v1 data interface "
                            "carries both. Source observation identities declare association.">;
    PortIn<DataSet<T>, Async>                     in;
    PortIn<DataSet<T>, Async, Optional>           annotations;
    Annotated<std::string, "transport">           transport            = "websocket";
    Annotated<std::string, "endpoint">            endpoint             = "ws://127.0.0.1:18089/waterfall";
    Annotated<std::uint32_t, "update_ms">         update_ms            = 100;
    Annotated<gr::Size_t, "signal_index">         signal_index         = 0;
    Annotated<gr::Size_t, "axis_index">           axis_index           = 0;
    Annotated<gr::Size_t, "max_rows">             max_rows             = 256;
    Annotated<gr::Size_t, "max_bytes">            max_bytes            = 64 * 1024 * 1024;
    Annotated<gr::Size_t, "annotation_max_items"> annotation_max_items = 10000;
    Annotated<gr::Size_t, "annotation_max_bytes",
        Doc<"Annotation history budget; limited to half max_snapshot_bytes. "
            "Visible observations take retention priority.">>
                                                      annotation_max_bytes     = 64 * 1024 * 1024;
    Annotated<gr::Size_t, "max_clients">              max_clients              = 8;
    Annotated<gr::Size_t, "pending_bytes_per_client"> pending_bytes_per_client = 4 * 1024 * 1024;
    Annotated<gr::Size_t, "max_snapshot_bytes">       max_snapshot_bytes       = 128 * 1024 * 1024;
    Annotated<std::string, "scope_mode",
        Doc<"configured: use graph scope; producer: adopt explicit native "
            "data identity">>
                                                       scope_mode               = "configured";
    Annotated<std::string, "run_namespace">            run_namespace            = "";
    Annotated<std::string, "source_epoch">             source_epoch             = "";
    Annotated<std::string, "producer_instance">        producer_instance        = "waterfall";
    Annotated<std::string, "source_id_key">            source_id_key            = "source_id";
    Annotated<std::string, "acquisition_id_key">       acquisition_id_key       = "acquisition_id";
    Annotated<std::string, "sequence_key">             sequence_key             = "sequence";
    Annotated<std::string, "coordinate_model_key">     coordinate_model_key     = "coordinate_model";
    Annotated<std::string, "timestamp_provenance_key"> timestamp_provenance_key = "timestamp_provenance";
    Annotated<std::string, "timestamp_raw_text_key">   timestamp_raw_text_key   = "timestamp_raw_text";
    Annotated<std::string, "timestamp_unix_ns_key">    timestamp_unix_ns_key    = "timestamp_unix_ns";
    Annotated<std::string, "validity_key">             validity_key             = "validity";
    Annotated<std::string, "coverage_key">             coverage_key             = "coverage";
    std::uint64_t                                      annotation_items = 0, annotation_publication_cursor = 0, rejected_annotations = 0, annotation_capacity_evictions = 0, subscriber_resyncs = 0;
    std::uint64_t                                      accepted_items = 0, publication_cursor = 0, transport_drain_failures = 0;
    std::string                                        last_error;
    std::uint64_t                                      invalid_rows = 0, duplicate_rows = 0, late_rows = 0, conflicting_rows = 0, subscriber_overflows = 0;
    GR_MAKE_REFLECTABLE(StudioDataSetWaterfallSink, subscriber_resyncs, annotation_max_items, annotation_max_bytes, annotation_capacity_evictions, scope_mode, in, annotations, annotation_items, annotation_publication_cursor, rejected_annotations, transport, endpoint, update_ms, signal_index, axis_index, max_rows, max_bytes, max_clients, pending_bytes_per_client, max_snapshot_bytes, run_namespace, source_epoch, producer_instance, source_id_key, acquisition_id_key, sequence_key, coordinate_model_key, timestamp_provenance_key, timestamp_raw_text_key, timestamp_unix_ns_key, validity_key, coverage_key, invalid_rows, duplicate_rows, late_rows, conflicting_rows, subscriber_overflows, last_error, accepted_items, publication_cursor, transport_drain_failures);
    using Block<StudioDataSetWaterfallSink<T>>::Block;
    void start() {
        if (scope_mode.value != "configured" && scope_mode.value != "producer") {
            throw gr::exception("invalid scope_mode");
        }
        if (!endpoint.value.starts_with("ws://")) {
            throw gr::exception("Dataset waterfall requires a ws:// endpoint");
        }
        if (transport.value != "websocket") {
            throw gr::exception("Dataset waterfall requires native websocket transport");
        }
        dataset_waterfall::Config c;
        c.signal_index              = signal_index;
        c.axis_index                = axis_index;
        c.max_rows                  = max_rows;
        c.max_bytes                 = max_bytes;
        c.max_clients               = max_clients;
        c.queue_bytes               = pending_bytes_per_client;
        c.snapshot_bytes            = max_snapshot_bytes;
        c.annotation_max_items      = annotation_max_items;
        c.annotation_max_bytes      = annotation_max_bytes;
        c.source_identity_from_data = scope_mode.value == "producer";
        c.run_namespace             = run_namespace;
        c.source_epoch              = source_epoch;
        c.producer_instance         = producer_instance;
        c.source_key                = source_id_key;
        c.acquisition_key           = acquisition_id_key;
        c.sequence_key              = sequence_key;
        c.model_key                 = coordinate_model_key;
        c.provenance_key            = timestamp_provenance_key;
        c.raw_time_key              = timestamp_raw_text_key;
        c.unix_ns_key               = timestamp_unix_ns_key;
        c.validity_key              = validity_key;
        c.coverage_key              = coverage_key;
        subscriber_resyncs = annotation_capacity_evictions = annotation_items = annotation_publication_cursor = rejected_annotations = accepted_items = publication_cursor = transport_drain_failures = 0;
        if (c.run_namespace.empty()) {
            c.run_namespace = dataset_waterfall::epoch();
        }
        if (c.source_epoch.empty()) {
            c.source_epoch = c.run_namespace;
        }
        _store.configure(c);
        auto e = detail::parseHttpEndpoint(endpoint.value);
        _service.start(_store, e.host, e.port, e.path, update_ms, c.max_clients, c.snapshot_bytes);
        _running = true;
    }
    void stop() {
        transport_drain_failures = _service.stop();
        _running                 = false;
        refreshCounters();
        this->updateActiveParameters({"accepted_items", "publication_cursor", "transport_drain_failures"});
    }
    void settingsChanged(const property_map&, const property_map& changed) {
        if (!_running) {
            return;
        }
        for (const auto& [key, value] : changed) {
            if (key == "subscriber_resyncs" || key == "annotation_capacity_evictions" || key == "annotation_items" || key == "annotation_publication_cursor" || key == "rejected_annotations" || key == "accepted_items" || key == "publication_cursor" || key == "transport_drain_failures" || key == "invalid_rows" || key == "duplicate_rows" || key == "late_rows" || key == "conflicting_rows" || key == "subscriber_overflows" || key == "last_error") {
                continue;
            }
            (void)value;
            throw gr::exception("Dataset waterfall settings are immutable while "
                                "running; stop and create a fresh execution");
        }
    }
    void ingestSpectra(std::span<const DataSet<T>> input) {
        for (const auto& d : input) {
            if (_store.push(d)) {
                ++accepted_items;
            }
        }
        refreshCounters();
    }
    void ingestAnnotations(std::span<const DataSet<T>> input) {
        for (const auto& d : input) {
            if (_store.pushAnnotations(d)) {
                ++annotation_items;
            }
        }
        refreshCounters();
    }
    [[nodiscard]] work::Status processBulk(gr::InputSpanLike auto& input, gr::InputSpanLike auto& annotationInput) {
        ingestSpectra(input);
        ingestAnnotations(annotationInput);
        const auto count = input.size() + annotationInput.size();
        std::ignore      = input.consume(input.size());
        std::ignore      = annotationInput.consume(annotationInput.size());
        return count ? work::Status::OK : work::Status::INSUFFICIENT_INPUT_ITEMS;
    }
    void refreshCounters() {
        subscriber_resyncs            = _store.subscriberResyncs();
        annotation_capacity_evictions = _store.annotationCapacityEvictions();
        publication_cursor            = _store.publicationCursor();
        annotation_publication_cursor = _store.annotationCursor();
        rejected_annotations          = _store.rejectedAnnotations();
        auto counters                 = _store.diagnostics();
        invalid_rows                  = counters[0];
        duplicate_rows                = counters[1];
        late_rows                     = counters[2];
        conflicting_rows              = counters[3];
        subscriber_overflows          = counters[4];
        last_error                    = _store.lastError();
        this->updateActiveParameters({"subscriber_resyncs", "annotation_capacity_evictions", "annotation_items", "annotation_publication_cursor", "rejected_annotations", "accepted_items", "publication_cursor", "last_error", "invalid_rows", "duplicate_rows", "late_rows", "conflicting_rows", "subscriber_overflows"});
    }

private:
    bool                                                                                                                _running = false;
    dataset_waterfall::AnnotatedStore                                                                                   _store;
    dataset_waterfall::BasicWebSocketService<dataset_waterfall::AnnotatedStore, dataset_waterfall::AnnotatedSubscriber> _service;
};
} // namespace gr::studio
