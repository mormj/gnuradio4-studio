// SPDX-License-Identifier: MIT
#pragma once
#include <gnuradio-4.0/Block.hpp>
#include <gnuradio-4.0/BlockRegistry.hpp>
#include <gnuradio-4.0/studio/StudioAnnotationStore.hpp>
#include <gnuradio-4.0/studio/StudioDataSetSink.hpp>
#include <gnuradio-4.0/studio/StudioIncrementalWebSocket.hpp>
namespace gr::studio {
GR_REGISTER_BLOCK("gr::studio::StudioAnnotationSink", gr::studio::StudioAnnotationSink, [T], [double])
template<typename T>
struct StudioAnnotationSink : Block<StudioAnnotationSink<T>> {
    static_assert(std::same_as<T, double>);
    using Description = Doc<"SigMF-compatible annotation_updates v1, with explicit sample or "
                            "observation coordinates. Legacy studio_annotations v1 accepted. "
                            "Bounded persistent plot-annotations-json-v1 WebSocket stream.">;
    PortIn<DataSet<T>>                                in;
    Annotated<std::string, "transport">               transport                = "websocket";
    Annotated<std::string, "endpoint">                endpoint                 = "ws://127.0.0.1:18090/annotations";
    Annotated<std::uint32_t, "update_ms">             update_ms                = 100;
    Annotated<gr::Size_t, "max_items">                max_items                = 10000;
    Annotated<gr::Size_t, "max_bytes">                max_bytes                = 32 * 1024 * 1024;
    Annotated<gr::Size_t, "max_clients">              max_clients              = 8;
    Annotated<gr::Size_t, "pending_bytes_per_client"> pending_bytes_per_client = 4 * 1024 * 1024;
    Annotated<gr::Size_t, "max_snapshot_bytes">       max_snapshot_bytes       = 128 * 1024 * 1024;
    Annotated<std::string, "scope_mode",
        Doc<"configured: use graph scope; producer: adopt explicit native "
            "data identity">>
                                                scope_mode        = "configured";
    Annotated<std::string, "run_namespace">     run_namespace     = "";
    Annotated<std::string, "producer_instance"> producer_instance = "annotations";
    std::uint64_t                               accepted_items = 0, publication_cursor = 0, transport_drain_failures = 0;
    std::string                                 last_error;
    std::uint64_t                               rejected_updates = 0, duplicate_updates = 0, late_updates = 0, conflicting_updates = 0, subscriber_overflows = 0, retained_items = 0;
    GR_MAKE_REFLECTABLE(StudioAnnotationSink, scope_mode, in, transport, endpoint, update_ms, max_items, max_bytes, max_clients, pending_bytes_per_client, max_snapshot_bytes, run_namespace, producer_instance, last_error, rejected_updates, duplicate_updates, late_updates, conflicting_updates, subscriber_overflows, retained_items, accepted_items, publication_cursor, transport_drain_failures);
    using Block<StudioAnnotationSink<T>>::Block;
    void start() {
        if (scope_mode.value != "configured" && scope_mode.value != "producer") {
            throw gr::exception("invalid scope_mode");
        }
        if (transport.value != "websocket" || !endpoint.value.starts_with("ws://")) {
            throw gr::exception("Annotations require native websocket transport and ws:// endpoint");
        }
        annotations::Config c;
        c.run_namespace     = run_namespace;
        c.producer_instance = producer_instance;
        c.max_items         = max_items;
        c.max_bytes         = max_bytes;
        c.max_clients       = max_clients;
        c.queue_bytes       = pending_bytes_per_client;
        c.snapshot_bytes    = max_snapshot_bytes;
        _adopted_run.clear();
        _adopted_producer.clear();
        accepted_items = publication_cursor = transport_drain_failures = 0;
        if (scope_mode.value == "producer") {
            c.run_namespace.clear();
        }
        _config = c;
        if (c.run_namespace.empty()) {
            c.run_namespace = dataset_waterfall::epoch();
        }
        _store.configure(c);
        auto e = detail::parseHttpEndpoint(endpoint.value);
        _service.start(_store, e.host, e.port, e.path, update_ms, c.max_clients, c.snapshot_bytes);
        _running = true;
    }
    void stop() {
        transport_drain_failures = _service.stop();
        _running                 = false;
        publication_cursor       = _store.publicationCursor();
        this->updateActiveParameters({"accepted_items", "publication_cursor", "transport_drain_failures"});
    }
    void settingsChanged(const property_map&, const property_map& changed) {
        if (_running) {
            for (auto& [key, value] : changed) {
                (void)value;
                if (key != "accepted_items" && key != "publication_cursor" && key != "transport_drain_failures" && key != "last_error" && key != "rejected_updates" && key != "duplicate_updates" && key != "late_updates" && key != "conflicting_updates" && key != "subscriber_overflows" && key != "retained_items") {
                    throw gr::exception("Annotation settings immutable during execution");
                }
            }
        }
    }
    [[nodiscard]] work::Status processBulk(std::span<const DataSet<T>>& input) {
        for (auto& d : input) {
            if (_config.run_namespace.empty() && !d.meta_information.empty()) {
                const auto& scope = annotations::object(d.meta_information[0], "scope");
                const auto  run = annotations::text(scope, "run_namespace"), producer = annotations::text(scope, "producer_instance");
                if (run != _adopted_run || producer != _adopted_producer) {
                    auto c              = _config;
                    c.run_namespace     = run;
                    c.producer_instance = producer;
                    _store.configure(c, true);
                    _adopted_run      = run;
                    _adopted_producer = producer;
                }
            }
            if (_store.push(d)) {
                ++accepted_items;
            }
        }
        publication_cursor   = _store.publicationCursor();
        auto c               = _store.diagnostics();
        rejected_updates     = c[0];
        duplicate_updates    = c[1];
        late_updates         = c[2];
        conflicting_updates  = c[3];
        subscriber_overflows = c[4];
        retained_items       = c[5];
        last_error           = _store.lastError();
        this->updateActiveParameters({"accepted_items", "publication_cursor", "last_error", "rejected_updates", "duplicate_updates", "late_updates", "conflicting_updates", "subscriber_overflows", "retained_items"});
        return work::Status::OK;
    }

private:
    annotations::Config                                                                   _config;
    std::string                                                                           _adopted_run, _adopted_producer;
    bool                                                                                  _running = false;
    annotations::Store                                                                    _store;
    dataset_waterfall::BasicWebSocketService<annotations::Store, annotations::Subscriber> _service;
};
} // namespace gr::studio
