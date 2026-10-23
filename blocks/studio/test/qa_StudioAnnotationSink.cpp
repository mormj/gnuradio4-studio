// SPDX-License-Identifier: MIT
#include <cassert>
#include <fstream>
#include <gnuradio-4.0/studio/StudioAnnotationSink.hpp>
#include <gnuradio-4.0/studio/StudioSyntheticAnnotationSource.hpp>
#include <iostream>
using namespace gr::studio;
using namespace gr::studio::annotations;
using gr::property_map;
gr::DataSet<double> update(std::uint64_t batch, std::uint64_t revision, const std::string& id = "region") {
    SyntheticAnnotationSource source;
    source.run_namespace     = "test-run";
    source.source_epoch      = "test-run";
    source.producer_instance = "annotations";
    source.start();
    auto d                                          = source.next();
    d.meta_information[0]["producer_batch_ordinal"] = batch;
    auto& rows                                      = *d.meta_information[0].at("rows").get_if<property_map>();
    auto& event                                     = *rows.at("0").get_if<property_map>();
    auto& a                                         = *event.at("value").get_if<property_map>();
    a["annotation_id"]                              = id;
    a["revision"]                                   = revision;
    return d;
}
property_map& event(gr::DataSet<double>& d) { return *d.meta_information[0].at("rows").get_if<property_map>()->at("0").get_if<property_map>(); }
property_map& value(gr::DataSet<double>& d) { return *event(d).at("value").get_if<property_map>(); }
std::string   receive(dataset_waterfall::ws::stream<dataset_waterfall::tcp::socket>& socket) {
    dataset_waterfall::beast::flat_buffer b;
    socket.read(b);
    return dataset_waterfall::beast::buffers_to_string(b.data());
}
int main(int argc, char** argv) {
    // A future SigMF source uses the same generic annotation input. Sample
    // positions are exact and remain distinct from sweep observation keys.
    property_map sigmf{{"core:sample_start", std::uint64_t(9007199254740993ULL)}, {"core:sample_count", std::uint64_t(4096)}, {"core:freq_lower_edge", 902e6}, {"core:freq_upper_edge", 903e6}, {"core:label", std::string("Signal")}, {"core:comment", std::string("source supplied")}, {"example:confidence", 0.75}, {"gr4:annotation_id", std::string("recorded-annotation")}, {"gr4:revision", std::uint64_t(1)}, {"gr4:recording_id", std::string("recording-A")}};
    auto         normalized = normalize_annotation(sigmf);
    assert(text(normalized, "label") == "Signal");
    assert(integer(object(normalized, "y_axis"), "start") == 9007199254740993ULL);
    annotation(normalized, "test-run");
    assert(object(normalized, "sigmf") == sigmf);
    for (int bad = 0; bad < 7; ++bad) {
        auto invalid = sigmf;
        if (bad == 0) {
            invalid.erase("core:freq_upper_edge");
        }
        if (bad == 1) {
            invalid["core:sample_start"] = std::uint64_t(UINT64_MAX);
        }
        if (bad == 2) {
            invalid["core:sample_count"] = std::uint64_t(INT64_MAX);
        }
        if (bad == 3) {
            invalid["gr4:observation"] = property_map{};
        }
        if (bad == 4) {
            invalid.erase("gr4:recording_id");
        }
        if (bad == 5) {
            invalid["core:uuid"] = std::string("not-a-uuid");
        }
        if (bad == 6) {
            invalid["core:freq_lower_edge"] = NAN;
        }
        bool rejected = false;
        try {
            normalize_annotation(invalid);
        } catch (const std::exception&) {
            rejected = true;
        }
        assert(rejected);
    }
    auto openEnded = sigmf;
    openEnded.erase("core:sample_count");
    assert(!object(normalize_annotation(openEnded), "y_axis").contains("count"));
    auto zero                 = sigmf;
    zero["core:sample_count"] = std::uint64_t(0);
    annotation(normalize_annotation(zero), "test-run");
    Config c;
    c.run_namespace = "test-run";
    Store s;
    s.configure(c);
    // The store follows explicit producer policy, never a domain state name.
    for (int policy = 0; policy < 3; ++policy) {
        Config bounded    = c;
        bounded.max_items = 2;
        Store retained;
        retained.configure(bounded);
        assert(retained.push(update(0, 1, "oldest")));
        auto         labelled = update(1, 1, "labelled");
        property_map style{{"state", std::string(policy == 2 ? "custom-finished" : "CLOSED")}};
        if (policy != 0) {
            style["terminal"] = policy == 2;
        }
        value(labelled)["style"] = std::move(style);
        assert(retained.push(labelled));
        auto reader = retained.subscribe();
        bool failed = false;
        retained.take(reader, failed);
        assert(retained.push(update(2, 1, "newest")));
        auto       evicted  = retained.take(reader, failed)->json();
        const auto expected = policy == 2 ? "labelled" : "oldest";
        assert(evicted.find("\"evicted_ids\":[\"" + std::string(expected) + "\"]") != std::string::npos);
    }

    auto canonical                        = update(0, 1);
    canonical.meta_information[0]["kind"] = std::string("annotation_updates");
    value(canonical)                      = sigmf;
    assert(s.push(canonical));
    auto canonicalWire = s.snapshot();
    assert(canonicalWire.find("\"start\":\"9007199254740993\"") != std::string::npos);
    assert(canonicalWire.find("example:confidence") != std::string::npos);
    s.configure(c);
    auto subscriber      = s.subscribe();
    bool canonicalFailed = false;
    s.take(subscriber, canonicalFailed);
    assert(s.push(canonical));
    auto delta = s.take(subscriber, canonicalFailed)->json();
    assert(delta.find("\"y_axis\"") != std::string::npos && delta.find("\"sigmf\"") != std::string::npos);
    s.configure(c);

    {
        Store immutable;
        immutable.configure(c);
        assert(immutable.push(update(0, 1)));
        auto       captured     = immutable.snapshotTransaction();
        const auto original     = captured->json();
        auto       changed      = update(1, 2);
        value(changed)["label"] = std::string("new snapshot label");
        assert(immutable.push(changed));
        assert(captured->json() == original && immutable.snapshot().find("new snapshot label") != std::string::npos);
        immutable.configure(c);
        assert(captured->json() == original);
    }
    auto a = s.subscribe(), b = s.subscribe();
    bool failed = false;
    assert(s.take(a, failed)->snapshot);
    s.take(b, failed);
    assert(s.push(update(0, 9007199254740993ULL)));
    auto first = s.take(a, failed);
    assert(first && !first->snapshot);
    assert(first->json() == s.take(b, failed)->json());
    assert(s.diagnostics()[5] == 1);
    assert(s.push(update(1, 9007199254740994ULL)));
    assert(s.diagnostics()[5] == 1);
    assert(s.push(update(2, 9007199254740993ULL)));
    assert(s.diagnostics()[2] == 1);
    assert(s.push(update(3, 9007199254740994ULL)));
    assert(s.diagnostics()[1] == 1);
    auto d            = update(4, 9007199254740994ULL);
    value(d)["label"] = std::string("conflict");
    auto before       = s.snapshot();
    assert(!s.push(d));
    assert(s.diagnostics()[3] == 1);
    s.take(a, failed);
    assert(failed);
    assert(s.snapshot().find("conflict") == std::string::npos);
    assert(!s.subscribe());
    s.configure(c);
    assert(s.push(update(0, UINT64_MAX)));
    assert(s.snapshot().find("18446744073709551615") != std::string::npos);
    s.configure(c);
    assert(s.push(update(0, 1)));
    d        = update(1, 2);
    event(d) = {{"operation", std::string("delete")}, {"annotation_id", std::string("region")}, {"revision", std::uint64_t(2)}};
    assert(s.push(d));
    assert(s.snapshot().find("\"items\":[]") != std::string::npos);
    assert(s.snapshot().find("\"tombstones\":[{") != std::string::npos);
    assert(s.push(update(2, 1)));
    assert(s.snapshot().find("\"items\":[]") != std::string::npos);
    assert(s.push(update(3, 3)));
    d        = update(4, 4);
    event(d) = {{"operation", std::string("clear")}};
    assert(s.push(d));
    assert(s.diagnostics()[5] == 0);
    s.configure(c);
    d = update(0, 1);
    assert(s.push(d));
    assert(s.push(d));
    assert(s.diagnostics()[1] == 1);
    value(d)["label"] = std::string("conflicting batch");
    assert(!s.push(d));
    assert(s.diagnostics()[3] == 1);
    s.configure(c);
    // Shape, typed uint64, explicit coordinates and geometry validation.
    for (int i = 0; i < 8; i++) {
        d = update(10 + i, 10 + i);
        if (i == 0) {
            value(d)["revision"] = 9007199254740993.0;
        }
        if (i == 1) {
            value(d)["geometry"] = property_map{{"kind", std::string("range")}, {"x_min", 5.0}, {"x_max", 1.0}};
        }
        if (i == 2) {
            value(d)["x_axis"] = property_map{{"kind", std::string("frequency")}, {"unit", std::string("kHz")}};
        }
        if (i == 3) {
            value(d)["geometry"] = property_map{{"kind", std::string("polygon")}};
        }
        if (i == 4) {
            d.extents = {2};
        }
        if (i == 5) {
            value(d)["label"] = std::string(257, 'x');
        }
        if (i == 6) {
            value(d)["unexpected"] = true;
        }
        if (i == 7) {
            d.axis_values[0][0] = NAN;
        }
        assert(!s.push(d));
    }
    // Bounded authoritative snapshot, explicit eviction and tombstone pruning
    // epoch reset.
    c.max_items = 2;
    s.configure(c);
    a = s.subscribe();
    s.take(a, failed);
    assert(s.push(update(0, 1, "a")));
    s.take(a, failed);
    assert(s.push(update(1, 1, "b")));
    s.take(a, failed);
    assert(s.push(update(2, 1, "c")));
    auto eviction = s.take(a, failed);
    assert(eviction->json().find("\"evicted_ids\":[\"a\"]") != std::string::npos);
    assert(s.diagnostics()[5] == 2);
    s.configure(c);
    d        = update(0, 1);
    event(d) = {{"operation", std::string("delete")}, {"annotation_id", std::string("dead")}, {"revision", std::uint64_t(1)}};
    assert(s.push(d));
    auto epochBefore = s.snapshot();
    assert(s.push(update(1, 1, "b")));
    a = s.subscribe();
    s.take(a, failed);
    assert(s.push(update(2, 1, "c")));
    assert(s.take(a, failed)->snapshot);
    // Per-client overflow never skips publication transactions.
    c.max_items   = 10000;
    c.queue_bytes = 1024;
    s.configure(c);
    a = s.subscribe();
    s.take(a, failed);
    for (std::uint64_t i = 0; i < 10; ++i) {
        assert(s.push(update(i, i + 1)));
    }
    s.take(a, failed);
    assert(failed && s.diagnostics()[4] == 1);
    // Shared stream transport: independent viewers, reconnect running/idle,
    // snapshot barrier.
    c.queue_bytes = 4 * 1024 * 1024;
    s.configure(c);
    dataset_waterfall::BasicWebSocketService<Store, Subscriber> service;
    service.start(s, "127.0.0.1", 0, "/annotations", 1, 8, c.snapshot_bytes);
    dataset_waterfall::net::io_context io;
    auto                               connect = [&] {
        auto w = std::make_unique<dataset_waterfall::ws::stream<dataset_waterfall::tcp::socket>>(io);
        w->next_layer().connect({dataset_waterfall::net::ip::make_address("127.0.0.1"), service.port()});
        w->handshake("127.0.0.1", "/annotations");
        return w;
    };
    auto w1 = connect(), w2 = connect();
    assert(receive(*w1) == receive(*w2));
    assert(s.push(update(0, 1)));
    assert(receive(*w1) == receive(*w2));
    w1->close(dataset_waterfall::ws::close_code::normal);
    assert(s.push(update(1, 2)));
    receive(*w2);
    w1 = connect();
    assert(receive(*w1).find("\"revision\":\"2\"") != std::string::npos);
    w2->close(dataset_waterfall::ws::close_code::normal);
    w2 = connect();
    assert(receive(*w2).find("\"message\":\"snapshot\"") != std::string::npos);
    w1->close(dataset_waterfall::ws::close_code::normal);
    w2->close(dataset_waterfall::ws::close_code::normal);
    service.stop();
    // Actual annotation socket overflow: client closes and reconnects to a
    // complete snapshot.
    c.queue_bytes = 1024;
    s.configure(c);
    service.start(s, "127.0.0.1", 0, "/annotations", 1, 8, c.snapshot_bytes);
    w1 = connect();
    receive(*w1);
    assert(s.push(update(0, 1)));
    dataset_waterfall::beast::flat_buffer buffer;
    dataset_waterfall::beast::error_code  ec;
    w1->read(buffer, ec);
    assert(ec && s.diagnostics()[4] == 1);
    service.stop();
    c.queue_bytes = 4 * 1024 * 1024;
    c.max_bytes   = 1024;
    s.configure(c);
    assert(!s.push(update(0, 1)));
    assert(s.diagnostics()[5] == 0);
    c.max_bytes = 32 * 1024 * 1024;
    // Finite teardown must dispatch queued final publications even when the
    // update timer is far away.
    c.max_bytes   = 32 * 1024 * 1024;
    c.queue_bytes = 4 * 1024 * 1024;
    s.configure(c);
    service.start(s, "127.0.0.1", 0, "/annotations", 100000, 8, c.snapshot_bytes);
    w1 = connect();
    w2 = connect();
    receive(*w1);
    receive(*w2);
    for (std::uint64_t i = 0; i < 3; ++i) {
        assert(s.push(update(i, i + 1)));
    }
    auto reader = [&](auto& client) {
        for (int i = 0; i < 3; ++i) {
            auto message = receive(*client);
            assert(message.find("\"message\":\"delta\"") != std::string::npos);
        }
        dataset_waterfall::beast::flat_buffer tail;
        dataset_waterfall::beast::error_code  closed;
        client->read(tail, closed);
        assert(closed == dataset_waterfall::ws::error::closed);
    };
    std::jthread read1([&] { reader(w1); }), read2([&] { reader(w2); });
    assert(service.stop() == 0);
    read1.join();
    read2.join();
    assert(s.publicationCursor() == 3);
    // No client is an immediate drain, without waiting for a timer or a future
    // connection.
    service.start(s, "127.0.0.1", 0, "/annotations", 100000, 8, c.snapshot_bytes);
    auto noClient = std::chrono::steady_clock::now();
    assert(service.stop() == 0);
    assert(std::chrono::steady_clock::now() - noClient < std::chrono::milliseconds(500));
    // An application that never reads cannot hold teardown forever. Its failed
    // drain is reported.
    service.start(s, "127.0.0.1", 0, "/annotations", 100000, 8, c.snapshot_bytes);
    w1 = connect();
    receive(*w1);
    assert(s.push(update(3, 4)));
    auto slowClient = std::chrono::steady_clock::now();
    assert(service.stop() == 1);
    assert(std::chrono::steady_clock::now() - slowClient < std::chrono::seconds(3));
    w1.reset();
    // Prior qualification workload: 3014 creations, 16185 updates, closed
    // history, exact large IDs.
    s.configure(c);
    auto start = std::chrono::steady_clock::now();
    for (std::uint64_t i = 0; i < 16185; ++i) {
        d = update(i, i + 1, "region-" + std::to_string(9007199254740993ULL + i % 3014));
        if (i >= 13171) {
            value(d)["style"] = property_map{{"state", std::string("CLOSED")}};
        }
        assert(s.push(d));
    }
    auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    assert(s.diagnostics()[5] == 3014);
    auto snap = s.snapshot();
    if (argc > 1) {
        std::ofstream(argv[1]) << snap;
    }
    std::cout << "PASS annotation "
                 "revisions/delete/clear/geometry/retention/reconnect/overflow; "
                 "creations=3014 updates=16185 retained="
              << s.diagnostics()[5] << " updates_per_second=" << 16185 / seconds << " snapshot_bytes=" << snap.size() << '\n';
}
