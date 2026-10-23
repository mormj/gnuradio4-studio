// SPDX-License-Identifier: MIT
#include <cassert>
#include <chrono>
#include <fstream>
#include <gnuradio-4.0/studio/StudioDataSetWaterfallSink.hpp>
#include <gnuradio-4.0/studio/StudioSyntheticAnnotationSource.hpp>
#include <iostream>
using namespace gr::studio::dataset_waterfall;
gr::DataSet<double> spectrum(std::size_t n, std::uint64_t seq = std::uint64_t(9007199254740993ULL)) {
    gr::DataSet<double> d;
    d.extents    = {static_cast<std::int32_t>(n)};
    d.axis_names = {"frequency"};
    d.axis_units = {"Hz"};
    d.axis_values.resize(1);
    d.signal_names      = {"spectrum"};
    d.signal_quantities = {"power"};
    d.signal_units      = {"dBm"};
    for (std::size_t i = 0; i < n; ++i) {
        d.axis_values[0].push_back(902000000.1234567 + double(i) * 0.125);
        d.signal_values.push_back(-100.0 + double(i % 21));
    }
    d.meta_information = {gr::property_map{{"source_id", std::string("synthetic")}, {"acquisition_id", std::string("acquisition")}, {"sequence", seq}, {"coordinate_model", std::string("uniform_inclusive_actual_endpoints")}, {"timestamp_provenance", std::string("device_unzoned")}, {"timestamp_raw_text", std::string("2026-10-20T12:34:56")}}};
    return d;
}
Config config() {
    Config c;
    c.run_namespace = "test-run";
    c.source_epoch  = "test-run";
    return c;
}
std::shared_ptr<const Transaction> take(Store& s, const std::shared_ptr<Subscriber>& sub) {
    bool failed = false;
    auto t      = s.take(sub, failed);
    assert(!failed && t);
    return t;
}
std::string receive(ws::stream<tcp::socket>& socket) {
    beast::flat_buffer b;
    socket.read(b);
    return beast::buffers_to_string(b.data());
}
// Independent producer: observation identity and terminal style are data, not
// Producer-owned lifecycle names. Use exact sequences above JavaScript's
// integer range.
gr::DataSet<double> retainedAnnotation(std::uint64_t batch, std::uint64_t sequence, const std::string& id, bool terminal = false, bool dense = false) {
    gr::studio::SyntheticAnnotationSource source;
    source.run_namespace  = "test-run";
    source.source_epoch   = "test-run";
    source.first_sequence = sequence;
    source.start();
    auto  d                     = source.next();
    auto& m                     = d.meta_information[0];
    m["producer_batch_ordinal"] = batch;
    auto& rows                  = *m.at("rows").get_if<gr::property_map>();
    auto& operation             = *rows.at("0").get_if<gr::property_map>();
    auto& a                     = *operation.at("value").get_if<gr::property_map>();
    a["annotation_id"]          = id;
    a["revision"]               = batch + 1;
    a["style"]                  = gr::property_map{{"terminal", terminal}};
    auto reference              = source.key(0);
    reference["acquisition_id"] = std::string("acquisition");
    a["y_axis"]                 = gr::property_map{{"kind", std::string("observation")}, {"first", reference}, {"last", reference}};
    if (dense) {
        gr::property_map metadata;
        for (int i = 0; i < 6; ++i) {
            metadata[gr::property_map::key_type("evidence-" + std::to_string(i))] = std::string(1024, 'x');
        }
        a["metadata"] = std::move(metadata);
    }
    return d;
}
void qualifyAnnotationRetention() {
    constexpr std::uint64_t start = 9007199254740993ULL;
    AnnotatedStore          store;
    auto                    c = config();
    c.max_rows                = 3;
    c.annotation_max_items    = 3;
    store.configure(c);
    for (std::uint64_t i = 0; i < 4; ++i) {
        assert(store.push(spectrum(8, start + i)));
    }
    auto viewer = store.subscribe();
    bool failed = false;
    assert(store.take(viewer, failed));
    // An old ACTIVE annotation must be evicted before a visible terminal one.
    for (std::uint64_t i = 0; i < 4; ++i) {
        assert(store.pushAnnotations(retainedAnnotation(i, start + i, "ann-" + std::to_string(i), i != 0)));
        while (store.take(viewer, failed)) {
        }
        assert(!failed);
    }
    auto snapshot = store.subscribe();
    auto json     = store.take(snapshot, failed)->json();
    assert(json.find("\"annotation_id\":\"ann-0\"") == std::string::npos);
    for (int i = 1; i < 4; ++i) {
        assert(json.find("\"annotation_id\":\"ann-" + std::to_string(i) + "\"") != std::string::npos);
    }
    assert(store.annotationCapacityEvictions() == 0);
    assert(store.push(spectrum(8, start + 4)));
    assert(store.pushAnnotations(retainedAnnotation(4, start + 4, "ann-4", true)));
    assert(store.annotationCapacityEvictions() == 0);
    // Future annotations are protected until their independent measurement
    // branch catches up. Finite capacity loss must remain observable.
    assert(store.pushAnnotations(retainedAnnotation(5, start + 8, "ahead", true)));
    assert(store.annotationCapacityEvictions() == 1);
    auto reconnect = store.subscribe();
    json           = store.take(reconnect, failed)->json();
    assert(json.find("\"capacity_evicted_items\":\"1\"") != std::string::npos);
    assert(json.find("\"annotation_id\":\"ahead\"") != std::string::npos);
    store.configure(c);
    assert(store.annotationCapacityEvictions() == 0);
    // A realistic dense 256-row window exceeded the old fixed 16 MiB bound.
    // The new default retains all 768 independently supplied annotations.
    c = config();
    store.configure(c);
    for (std::uint64_t i = 0; i < 256; ++i) {
        assert(store.push(spectrum(8, start + i)));
    }
    for (std::uint64_t i = 0; i < 768; ++i) {
        assert(store.pushAnnotations(retainedAnnotation(i, start + i / 3, "dense-" + std::to_string(i), true, true)));
    }
    assert(store.annotationCapacityEvictions() == 0);
    reconnect = store.subscribe();
    assert(reconnect);
    auto transaction = store.take(reconnect, failed);
    assert(transaction && !failed);
    json = transaction->json();
    for (int i = 0; i < 768; ++i) {
        assert(json.find("\"annotation_id\":\"dense-" + std::to_string(i) + "\"") != std::string::npos);
    }
    // Explicitly smaller byte limits stay bounded and report lost visible
    // annotations instead of rejecting otherwise valid producer updates.
    c.annotation_max_bytes = 64 * 1024;
    store.configure(c);
    assert(store.push(spectrum(8, start)));
    for (std::uint64_t i = 0; i < 8; ++i) {
        assert(store.pushAnnotations(retainedAnnotation(i, start, "bounded-" + std::to_string(i), true, true)));
    }
    assert(store.annotationCapacityEvictions() > 0 && store.rejectedAnnotations() == 0);
}
void qualifyBoundedSubscriberRecovery() {
    AnnotatedStore store;
    auto           c = config();
    store.configure(c);
    auto slow = store.subscribe(), fast = store.subscribe();
    bool failed = false;
    assert(store.take(slow, failed));
    assert(store.take(fast, failed));
    std::uint64_t fast_cursor = 0;
    auto          readFast    = [&] {
        while (auto t = store.take(fast, failed)) {
            fast_cursor = t->measurement->cursor;
        }
        assert(!failed);
    };
    // Match the real 3,278-bin payload shape and float precision. A slow reader
    // exceeds its 4 MiB pending bound while a fast reader keeps every delta.
    for (std::uint64_t sequence = 1; sequence <= 300; ++sequence) {
        auto d = spectrum(3278, sequence);
        for (std::size_t i = 0; i < d.signal_values.size(); ++i) {
            d.signal_values[i] = -100.1234567890123 + double(i % 21) * 0.73123456789;
        }
        assert(store.push(d));
        readFast();
    }
    for (std::uint64_t i = 0; i < 768; ++i) {
        assert(store.pushAnnotations(retainedAnnotation(i, 45 + i / 3, "recovery-" + std::to_string(i), true, true)));
        readFast();
    }
    assert(slow->needs_snapshot && !slow->failed && slow->pending.empty() && slow->bytes == 0 && slow->delta_bytes == 0);
    const auto cursor = store.publicationCursor(), annotation_cursor = store.annotationCursor();
    auto       recovery = store.take(slow, failed);
    assert(recovery && recovery->snapshot && !failed);
    assert(recovery->measurement->cursor == cursor && fast_cursor == cursor);
    assert(recovery->measurement->rows.size() == 256 && recovery->measurement->rows.front()->sequence == 45 && recovery->measurement->rows.back()->sequence == 300);
    const auto json = recovery->json();
    assert(json.size() > 16 * 1024 * 1024 && json.size() <= c.snapshot_bytes);
    for (int i = 0; i < 768; ++i) {
        assert(json.find("\"annotation_id\":\"recovery-" + std::to_string(i) + "\"") != std::string::npos);
    }
    assert(store.subscriberResyncs() == 1 && store.publicationCursor() == cursor && store.annotationCursor() == annotation_cursor);
    // Subsequent deltas must resume exactly at the replacement snapshot cursor.
    assert(store.push(spectrum(3278, 301)));
    auto next = store.take(slow, failed);
    assert(next && !next->snapshot && !failed && next->measurement->base == cursor && next->measurement->rows.back()->sequence == 301);
    store.configure(c);
    assert(store.subscriberResyncs() == 0);
}
int main(int argc, char** argv) {
    {
        Store epochs;
        auto  c            = config();
        c.source_epoch_key = "observation_epoch";
        epochs.configure(c);
        auto d                                     = spectrum(8, 1);
        d.meta_information[0]["observation_epoch"] = std::string("1/1");
        assert(epochs.push(d));
        auto old                                   = epochs.snapshot();
        d.meta_information[0]["observation_epoch"] = std::string("1/2");
        assert(epochs.push(d));
        auto fresh = epochs.snapshot();
        assert(fresh->rows.size() == 1 && fresh->rows[0]->source_epoch == "test-run/1/2");
        assert(fresh->stream_epoch != old->stream_epoch && fresh->rows[0]->reset);
    }
    // Admit only the exact relative digital-power contracts, without conversion.
    for (const auto& [quantity, unit] : std::vector<std::pair<std::string, std::string>>{{"relative digital power", "dB re 1 digital power"}, {"relative digital power", "digital power"}, {"relative digital power spectral density", "digital power/Hz"}}) {
        Store relative;
        relative.configure(config());
        auto d                                        = spectrum(8);
        d.signal_quantities                           = {quantity};
        d.signal_units                                = {unit};
        d.meta_information[0]["timestamp_provenance"] = std::string("unknown");
        assert(relative.push(d));
        auto t = relative.snapshot();
        assert(t->grid->unit == unit && t->grid->x == d.axis_values[0]);
        assert(t->rows[0]->power == d.signal_values && !t->rows[0]->unix_ns);
        assert(t->rows[0]->sequence == 9007199254740993ULL);
        for (const auto& bad : std::vector<std::pair<std::string, std::string>>{{quantity, "dBm"}, {"power", unit}, {"unknown", unit}}) {
            Store invalid;
            invalid.configure(config());
            d.signal_quantities = {bad.first};
            d.signal_units      = {bad.second};
            assert(!invalid.push(d));
        }
    }

    qualifyAnnotationRetention();
    qualifyBoundedSubscriberRecovery();
    // A generic producer can send observations and annotations over one sink
    // interface. No application-specific type or frontend UUID is needed.
    {
        AnnotatedStore combined;
        auto           c            = config();
        c.source_identity_from_data = true;
        combined.configure(c);
        auto client = combined.subscribe();
        bool failed = false;
        combined.take(client, failed);
        auto data                                   = spectrum(421, 1);
        data.meta_information[0]["gr4:observation"] = gr::property_map{{"run_namespace", std::string("source-owned")}, {"source_epoch", std::string("source-owned")}, {"source_id", std::string("synthetic")}, {"acquisition_id", std::string("replay")}, {"sequence", std::uint64_t(1)}};
        assert(combined.push(data));
        auto first = combined.take(client, failed);
        assert(first && first->snapshot);
        assert(first->json().find("source-owned") != std::string::npos);
        gr::studio::SyntheticAnnotationSource producer;
        producer.run_namespace  = "source-owned";
        producer.source_epoch   = "source-owned";
        producer.first_sequence = 1;
        producer.start();
        assert(combined.pushAnnotations(producer.next()));
        assert(combined.annotationCursor() == 1);
        auto snapshot = combined.subscribe();
        auto complete = combined.take(snapshot, failed)->json();
        assert(complete.find("\"annotations\":{") != std::string::npos && complete.find("Region A") != std::string::npos);
        assert(combined.publicationCursor() == 3);
        auto initial = combined.take(client, failed);
        auto update  = combined.take(client, failed);
        assert(initial && update && initial->annotation && update->annotation && !failed);
        // Source restart with an explicitly reused acquisition still has a new
        // observation epoch and must not be classified as a conflicting replay.
        auto& key            = *data.meta_information[0].at("gr4:observation").get_if<gr::property_map>();
        key["run_namespace"] = std::string("new-source-run");
        key["source_epoch"]  = std::string("new-source-run");
        assert(combined.push(data));
        assert(combined.diagnostics()[3] == 0);
    }
    Store s;
    auto  c = config();
    s.configure(c);
    auto a = s.subscribe(), b = s.subscribe();
    assert(take(s, a)->snapshot && take(s, b)->rows.empty());
    for (auto n : {421UZ, 4096UZ, 6817UZ, 8192UZ}) {
        s.configure(c);
        auto d = spectrum(n);
        assert(s.push(d));
        auto t = s.snapshot();
        assert(t->rows.size() == 1);
        assert(t->grid->x == d.axis_values[0]);
        assert(t->rows[0]->power == d.signal_values);
        assert(t->rows[0]->sequence == std::uint64_t(9007199254740993ULL));
        assert(!t->rows[0]->unix_ns);
        assert(t->rows[0]->raw == "2026-10-20T12:34:56");
        auto json = t->json();
        assert(json.find("9007199254740993") != std::string::npos);
        assert(json.find("902000000.12345672") != std::string::npos);
    }
    c.max_rows = 2;
    s.configure(c);
    a = s.subscribe();
    take(s, a);
    auto d = spectrum(421);
    s.push(d);
    auto first = take(s, a);
    assert(first->snapshot);
    d.meta_information[0]["sequence"] = std::uint64_t(9007199254740994ULL);
    s.push(d);
    auto delta = take(s, a);
    assert(!delta->snapshot && delta->base == first->cursor && delta->rows.size() == 1);
    d.meta_information[0]["sequence"] = std::uint64_t(9007199254740996ULL);
    s.push(d);
    delta = take(s, a);
    assert(delta->removals.size() == 1 && delta->rows[0]->gap);
    assert(s.snapshot()->rows.size() == 2);
    assert(!s.push(d) && s.duplicates == 1);
    d.signal_values[0] = 1;
    assert(!s.push(d) && s.conflicts == 1);
    bool failed = false;
    s.take(a, failed);
    assert(failed);
    s.configure(c);
    d = spectrum(421);
    s.push(d);
    d.meta_information[0]["sequence"] = std::uint64_t(9007199254740992ULL);
    assert(!s.push(d) && s.late == 1);
    d = spectrum(421);
    d.axis_values[0][0] -= 1;
    assert(!s.push(d));
    for (int invalid = 0; invalid < 7; ++invalid) {
        d = spectrum(421);
        if (invalid == 0) {
            d.extents = {21, 20};
        }
        if (invalid == 1) {
            d.signal_units = {"bananas"};
        }
        if (invalid == 2) {
            d.axis_units = {"kHz"};
        }
        if (invalid == 3) {
            d.axis_values[0][2] = NAN;
        }
        if (invalid == 4) {
            d.signal_values[0] = INFINITY;
        }
        if (invalid == 5) {
            d.signal_values.pop_back();
        }
        if (invalid == 6) {
            d.meta_information[0]["sequence"] = 9007199254740993.0;
        }
        assert(!s.push(d));
    }
    s.configure(c);
    d = spectrum(421);
    s.push(d);
    auto old = s.snapshot()->stream_epoch;
    d        = spectrum(4096, std::uint64_t(9007199254740994ULL));
    s.push(d);
    assert(s.snapshot()->stream_epoch != old && s.snapshot()->rows.size() == 1);
    old                                     = s.snapshot()->stream_epoch;
    d.meta_information[0]["acquisition_id"] = std::string("new");
    s.push(d);
    assert(s.snapshot()->stream_epoch != old);
    old                                = s.snapshot()->stream_epoch;
    d.meta_information[0]["source_id"] = std::string("new-source");
    s.push(d);
    assert(s.snapshot()->stream_epoch != old);
    c             = config();
    c.queue_bytes = 60000;
    s.configure(c);
    a = s.subscribe();
    take(s, a);
    d = spectrum(421);
    s.push(d);
    take(s, a);
    for (std::uint64_t i = 1; i < 4; i++) {
        d.meta_information[0]["sequence"] = std::uint64_t(9007199254740993ULL) + i;
        s.push(d);
    }
    s.take(a, failed);
    assert(failed && s.overflows == 1);
    c             = config();
    c.max_clients = 2;
    s.configure(c);
    a = s.subscribe();
    b = s.subscribe();
    assert(!s.subscribe());
    c           = config();
    c.max_bytes = 10000;
    s.configure(c);
    assert(!s.push(spectrum(8192)));
    c           = config();
    c.max_bytes = 421 * 8 * 4;
    s.configure(c);
    for (std::uint64_t i = 0; i < 5; i++) {
        assert(s.push(spectrum(421, i)));
    }
    assert(s.snapshot()->rows.size() < 5 && s.snapshot()->evicted > 0);
    c = config();
    s.configure(c);
    assert(s.push(spectrum(421, UINT64_MAX)));
    assert(s.snapshot()->json().find("18446744073709551615") != std::string::npos);
    c.unix_ns_key = "$dataset.timestamp";
    s.configure(c);
    d                                             = spectrum(421);
    d.timestamp                                   = 123456789;
    d.meta_information[0]["timestamp_provenance"] = std::string("device_with_timezone");
    assert(s.push(d));
    assert(s.snapshot()->rows[0]->unix_ns == 123456789);
    c = config();
    s.configure(c);
    d = spectrum(421, 1);
    assert(s.push(d));
    d.signal_units = {"W"};
    assert(!s.push(d) && s.conflicts == 1);
    // All datasets in one actual GR4 input batch, no input.back() shortcut.
    gr::studio::StudioDataSetWaterfallSink<double> sink; // lifecycle/network exercised separately below
    // Native transaction synchronization and two simultaneous network viewers.
    c = config();
    s.configure(c);
    WebSocketService service;
    service.start(s, "127.0.0.1", 0, "/waterfall", 1, 8, c.snapshot_bytes);
    net::io_context io;
    auto            connect = [&]() {
        auto w = std::make_unique<ws::stream<tcp::socket>>(io);
        w->next_layer().connect(tcp::endpoint(net::ip::make_address("127.0.0.1"), service.port()));
        w->handshake("127.0.0.1", "/waterfall");
        return w;
    };
    auto w1 = connect(), w2 = connect();
    assert(receive(*w1).find("\"rows\":[]") != std::string::npos);
    assert(receive(*w2).find("\"rows\":[]") != std::string::npos);
    d = spectrum(421);
    s.push(d);
    auto j = receive(*w1);
    assert(j == receive(*w2));
    d.meta_information[0]["sequence"] = std::uint64_t(9007199254740994ULL);
    s.push(d);
    j = receive(*w1);
    assert(j == receive(*w2) && j.find("\"message\":\"delta\"") != std::string::npos);
    // Cross the HTTP handshake deadline while connected and idle.
    std::this_thread::sleep_for(std::chrono::milliseconds(2200));
    d.meta_information[0]["sequence"] = std::uint64_t(9007199254740995ULL);
    s.push(d);
    j = receive(*w1);
    assert(j == receive(*w2));
    w1->close(ws::close_code::normal);
    w1 = connect();
    assert(receive(*w1).find("\"message\":\"snapshot\"") != std::string::npos);
    w1->close(ws::close_code::normal);
    w2->close(ws::close_code::normal);
    service.stop();
    service.start(s, "127.0.0.1", 0, "/waterfall", 1, 8, c.snapshot_bytes);
    w1 = connect();
    assert(receive(*w1).find("\"message\":\"snapshot\"") != std::string::npos);
    w1->close(ws::close_code::normal);
    service.stop();
    // Actual WebSocket overflow closes the client instead of skipping
    // transactions.
    c             = config();
    c.queue_bytes = 60000;
    s.configure(c);
    service.start(s, "127.0.0.1", 0, "/waterfall", 100, 8, c.snapshot_bytes);
    w1 = connect();
    receive(*w1);
    for (std::uint64_t i = 0; i < 100; i++) {
        s.push(spectrum(421, i));
    }
    bool disconnected = false;
    for (int i = 0; i < 10; i++) {
        beast::flat_buffer buffer;
        beast::error_code  ec;
        w1->read(buffer, ec);
        if (ec) {
            disconnected = true;
            break;
        }
    }
    assert(disconnected && s.overflows == 1);
    service.stop();
    // Actual block lifecycle and all datasets in one input batch.
    tcp::acceptor probe(io, tcp::endpoint(tcp::v4(), 0));
    auto          port = probe.local_endpoint().port();
    probe.close();
    sink.endpoint      = std::string("ws://127.0.0.1:") + std::to_string(port) + "/waterfall";
    sink.run_namespace = std::string("batch-run");
    sink.source_epoch  = std::string("batch-run");
    sink.start();
    std::array<gr::DataSet<double>, 3>   batch{spectrum(421, 1), spectrum(421, 2), spectrum(421, 3)};
    std::span<const gr::DataSet<double>> span(batch);
    sink.ingestSpectra(span);
    ws::stream<tcp::socket> batchClient(io);
    batchClient.next_layer().connect(tcp::endpoint(net::ip::make_address("127.0.0.1"), port));
    batchClient.handshake("127.0.0.1", "/waterfall");
    auto batchJson = receive(batchClient);
    for (auto seq : {"1", "2", "3"}) {
        assert(batchJson.find(std::string("\"sequence\":\"") + seq + "\"") != std::string::npos);
    }
    batchClient.close(ws::close_code::normal);
    sink.stop();
    sink.start();
    ws::stream<tcp::socket> restarted(io);
    restarted.next_layer().connect(tcp::endpoint(net::ip::make_address("127.0.0.1"), port));
    restarted.handshake("127.0.0.1", "/waterfall");
    assert(receive(restarted).find("\"rows\":[]") != std::string::npos);
    restarted.close(ws::close_code::normal);
    sink.stop();
    // Representative ingestion and encoding measurements; no acceptance
    // thresholds invented.
    c = config();
    s.configure(c);
    d          = spectrum(6817);
    auto start = std::chrono::steady_clock::now();
    for (std::uint64_t i = 0; i < 1000; i++) {
        d.meta_information[0]["sequence"] = std::uint64_t(9007199254740993ULL) + i;
        assert(s.push(d));
    }
    auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    auto t       = s.snapshot();
    start        = std::chrono::steady_clock::now();
    auto json    = t->json();
    auto ms      = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    if (argc > 1) {
        std::ofstream(argv[1]) << json;
    }
    std::cout << "PASS native store/transport; 6817 bins: rows/s=" << 1000 / elapsed << " row_json_bytes=" << t->rows.back()->json().size() << " snapshot_rows=" << t->rows.size() << " snapshot_bytes=" << json.size() << " snapshot_ms=" << ms << " power_grid_bytes=" << (256 * 6817 * 8 + 6817 * 8) << '\n';
}
