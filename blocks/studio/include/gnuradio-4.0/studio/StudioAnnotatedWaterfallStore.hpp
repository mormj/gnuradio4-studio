// SPDX-License-Identifier: MIT
#pragma once
#include <gnuradio-4.0/studio/StudioAnnotationStore.hpp>

namespace gr::studio::dataset_waterfall {
// One endpoint and publication order for independent measurement and annotation
// inputs. The nested annotation protocol stays generic and producer-owned.
struct AnnotatedTransaction {
    std::shared_ptr<const Transaction>              measurement;
    std::shared_ptr<const annotations::Transaction> annotation;
    std::size_t                                     bound    = 0;
    bool                                            snapshot = false;
    std::string                                     json() const {
        auto out = measurement->json();
        if (annotation) {
            out.pop_back();
            out += ",\"annotations\":" + annotation->json() + "}";
        }
        return out;
    }
};
struct AnnotatedSubscriber {
    std::deque<std::shared_ptr<const AnnotatedTransaction>> pending;
    std::size_t                                             bytes = 0, delta_bytes = 0;
    bool                                                    failed = false, needs_snapshot = false;
};
class AnnotatedStore {
    mutable std::mutex                              mutex;
    Store                                           measurements;
    annotations::Store                              annotation_store;
    Config                                          config;
    std::shared_ptr<Subscriber>                     measurement_reader;
    std::shared_ptr<annotations::Subscriber>        annotation_reader;
    std::vector<std::weak_ptr<AnnotatedSubscriber>> clients;
    std::uint64_t                                   cursor = 0, annotation_frames = 0, rejected_annotations = 0, annotation_overflows = 0, subscriber_resyncs = 0;
    std::string                                     annotation_run, annotation_producer, last_error;
    std::size_t                                     annotation_budget = 0;
    std::shared_ptr<const Row>                      window_first, window_last;
    bool                                            overlapsHistory(const property_map& annotation) const {
        if (!window_first || !window_last || !annotation.contains("y_axis")) {
            return true;
        }
        const auto& axis = annotations::object(annotation, "y_axis");
        if (annotations::text(axis, "kind") != "observation") {
            return true;
        }
        const auto& first = annotations::object(axis, "first");
        const auto& last  = annotations::object(axis, "last");
        if (annotations::text(first, "run_namespace") != window_first->run || annotations::text(first, "source_epoch") != window_first->source_epoch || annotations::text(first, "source_id") != window_first->source || annotations::text(first, "acquisition_id") != window_first->acquisition) {
            return false;
        }
        // Protect visible and ahead-of-measurement updates. Independent input
        // branches may deliver annotations before their measurement rows.
        return annotations::integer(last, "sequence") >= window_first->sequence;
    }
    std::shared_ptr<const AnnotatedTransaction> snapshotLocked() const {
        auto m    = std::make_shared<Transaction>(*measurements.snapshot());
        m->cursor = cursor;
        m->dropped += rejected_annotations;
        auto       a     = annotation_reader ? annotation_store.snapshotTransaction() : nullptr;
        const auto bytes = m->bound + (a ? a->bound : 0) + 32;
        return std::make_shared<AnnotatedTransaction>(AnnotatedTransaction{m, a, bytes, true});
    }
    void publish(std::shared_ptr<const Transaction> measurement, std::shared_ptr<const annotations::Transaction> annotation = {}) {
        if (cursor == UINT64_MAX) {
            throw std::overflow_error("combined publication cursor exhausted");
        }
        auto m    = std::make_shared<Transaction>(*measurement);
        m->base   = cursor;
        m->cursor = ++cursor;
        m->dropped += rejected_annotations;
        if (m->snapshot && !annotation && annotation_reader) {
            annotation = annotation_store.snapshotTransaction();
        }
        auto t = std::make_shared<AnnotatedTransaction>(AnnotatedTransaction{m, annotation, m->bound + (annotation ? annotation->bound : 0) + 32, m->snapshot});
        std::erase_if(clients, [](auto& w) { return w.expired(); });
        for (auto& w : clients) {
            if (auto c = w.lock(); c && !c->failed) {
                if (c->needs_snapshot) {
                    continue;
                }
                if (t->snapshot && t->bound > config.snapshot_bytes) {
                    c->failed = true;
                    c->pending.clear();
                    c->bytes = c->delta_bytes = 0;
                    ++annotation_overflows;
                } else if (t->bound > (t->snapshot ? config.snapshot_bytes : config.queue_bytes) || (t->snapshot ? c->bytes + t->bound > config.snapshot_bytes + config.queue_bytes : c->delta_bytes + t->bound > config.queue_bytes)) {
                    // This is a retained-state stream: one complete snapshot can
                    // supersede pending deltas without inventing domain updates.
                    // Capture lazily at take(), never once per producer update.
                    c->needs_snapshot = true;
                    c->pending.clear();
                    c->bytes = c->delta_bytes = 0;
                    ++annotation_overflows;
                } else {
                    c->pending.push_back(t);
                    c->bytes += t->bound;
                    if (!t->snapshot) {
                        c->delta_bytes += t->bound;
                    }
                }
            }
        }
    }
    void publishAnnotation(std::shared_ptr<const annotations::Transaction> a) {
        auto m      = std::make_shared<Transaction>(*measurements.snapshot());
        m->snapshot = false;
        m->rows.clear();
        m->removals.clear();
        m->grid.reset();
        m->bound = 8192;
        publish(m, std::move(a));
    }
    static DataSet<double> carrier(const property_map& metadata) {
        const auto n = annotations::integer(metadata, "update_count");
        if (n > 8192) {
            throw std::invalid_argument("annotation batch exceeds row bound");
        }
        DataSet<double> d;
        d.extents    = {static_cast<std::int32_t>(n)};
        d.axis_names = {"row_index"};
        d.axis_units = {"1"};
        d.axis_values.resize(1);
        d.signal_names      = {"row_ordinal"};
        d.signal_quantities = {"ordinal"};
        d.signal_units      = {"1"};
        for (std::size_t i = 0; i < n; ++i) {
            d.axis_values[0].push_back(double(i));
            d.signal_values.push_back(double(i));
        }
        d.meta_information = {metadata};
        return d;
    }
    bool pushAnnotation(const DataSet<double>& d) {
        if (d.meta_information.empty()) {
            throw std::invalid_argument("missing annotation metadata");
        }
        const auto& meta  = d.meta_information[0];
        const auto& scope = annotations::object(meta, "scope");
        const auto  run = annotations::text(scope, "run_namespace"), producer = annotations::text(scope, "producer_instance");
        if (!annotation_reader || run != annotation_run || producer != annotation_producer) {
            // Prevalidate the complete new producer batch before replacing scope.
            annotations::Store  candidate;
            annotations::Config c;
            c.run_namespace      = run;
            c.producer_instance  = producer;
            c.max_items          = config.annotation_max_items;
            c.max_bytes          = annotation_budget;
            c.snapshot_bytes     = annotation_budget;
            c.queue_bytes        = 128 * 1024 * 1024;
            c.retention_priority = [this](const property_map& a) { return overlapsHistory(a); };
            candidate.configure(c);
            if (!candidate.push(d)) {
                throw std::invalid_argument(candidate.lastError());
            }
            annotation_store.configure(c);
            annotation_reader   = annotation_store.subscribe();
            annotation_run      = run;
            annotation_producer = producer;
            bool failed         = false;
            publishAnnotation(annotation_store.take(annotation_reader, failed));
        }
        if (!annotation_store.push(d)) {
            throw std::invalid_argument(annotation_store.lastError());
        }
        bool failed = false;
        while (auto a = annotation_store.take(annotation_reader, failed)) {
            publishAnnotation(std::move(a));
        }
        if (failed) {
            throw std::invalid_argument("internal annotation queue overflow");
        }
        ++annotation_frames;
        return true;
    }

public:
    void configure(Config c) {
        std::lock_guard lock(mutex);
        if (c.annotation_max_items < 1 || c.annotation_max_items > 100000 || c.annotation_max_bytes < 4096 || c.annotation_max_bytes > 128 * 1024 * 1024 || c.snapshot_bytes < 32768 || c.snapshot_bytes > 128 * 1024 * 1024) {
            throw std::invalid_argument("invalid waterfall annotation limits");
        }
        config            = c;
        annotation_budget = std::min(c.annotation_max_bytes, c.snapshot_bytes / 2);
        window_first.reset();
        window_last.reset();
        cursor = annotation_frames = rejected_annotations = annotation_overflows = subscriber_resyncs = 0;
        last_error.clear();
        annotation_reader.reset();
        annotation_run.clear();
        annotation_producer.clear();
        for (auto& w : clients) {
            if (auto p = w.lock()) {
                p->failed = true;
            }
        }
        clients.clear();
        // Reserve the annotation budget inside the existing encoded message bound.
        c.snapshot_bytes = std::max<std::size_t>(1024, c.snapshot_bytes > annotation_budget + 8192 ? c.snapshot_bytes - annotation_budget - 8192 : c.snapshot_bytes / 2);
        c.queue_bytes    = 128 * 1024 * 1024;
        c.max_clients    = 1;
        measurements.configure(c);
        measurement_reader = measurements.subscribe();
        bool failed        = false;
        measurements.take(measurement_reader, failed);
    }
    bool push(const DataSet<double>& d) {
        std::lock_guard lock(mutex);
        const bool      accepted = measurements.push(d);
        bool            failed   = false;
        if (accepted) {
            auto history = measurements.snapshot();
            window_first = history->rows.empty() ? nullptr : history->rows.front();
            window_last  = history->rows.empty() ? nullptr : history->rows.back();
        }
        while (auto m = measurements.take(measurement_reader, failed)) {
            publish(std::move(m));
        }
        if (failed) {
            throw std::invalid_argument("internal measurement queue overflow");
        }
        return accepted;
    }
    bool pushAnnotations(const DataSet<double>& d) {
        std::lock_guard lock(mutex);
        try {
            if (d.meta_information.empty()) {
                throw std::invalid_argument("missing annotation data interface");
            }
            const auto& meta = d.meta_information[0];
            if (auto it = meta.find("gr4:annotations"); it != meta.end()) {
                auto batches = it->second.get_if<property_map>();
                if (!batches || batches->size() > 8192) {
                    throw std::invalid_argument("invalid attached annotation batches");
                }
                for (std::size_t i = 0; i < batches->size(); ++i) {
                    pushAnnotation(carrier(annotations::object(*batches, std::to_string(i))));
                }
                return true;
            }
            return pushAnnotation(d);
        } catch (const std::exception& e) {
            ++rejected_annotations;
            last_error  = e.what();
            auto m      = std::make_shared<Transaction>(*measurements.snapshot());
            m->snapshot = false;
            m->rows.clear();
            m->removals.clear();
            m->grid.reset();
            m->bound = 8192;
            publish(m);
            return false;
        }
    }
    std::shared_ptr<AnnotatedSubscriber> subscribe() {
        std::lock_guard lock(mutex);
        std::erase_if(clients, [](auto& w) { return w.expired(); });
        if (clients.size() >= config.max_clients) {
            return {};
        }
        auto s = std::make_shared<AnnotatedSubscriber>();
        auto t = snapshotLocked();
        if (t->bound > config.snapshot_bytes) {
            return {};
        }
        s->pending.push_back(t);
        s->bytes = t->bound;
        clients.push_back(s);
        return s;
    }
    std::shared_ptr<const AnnotatedTransaction> take(const std::shared_ptr<AnnotatedSubscriber>& s, bool& failed) {
        std::lock_guard lock(mutex);
        failed = s->failed;
        if (failed) {
            return {};
        }
        if (s->needs_snapshot) {
            auto t            = snapshotLocked();
            s->needs_snapshot = false;
            if (t->bound > config.snapshot_bytes) {
                s->failed = failed = true;
                return {};
            }
            ++subscriber_resyncs;
            return t;
        }
        if (s->pending.empty()) {
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
    std::uint64_t publicationCursor() const {
        std::lock_guard lock(mutex);
        return cursor;
    }
    std::uint64_t annotationCursor() const {
        std::lock_guard lock(mutex);
        return annotation_reader ? annotation_store.publicationCursor() : 0;
    }
    std::uint64_t subscriberResyncs() const {
        std::lock_guard lock(mutex);
        return subscriber_resyncs;
    }
    std::uint64_t annotationCapacityEvictions() const {
        std::lock_guard lock(mutex);
        return annotation_reader ? annotation_store.capacityEvictions() : 0;
    }
    std::uint64_t rejectedAnnotations() const {
        std::lock_guard lock(mutex);
        return rejected_annotations;
    }
    std::array<std::uint64_t, 5> diagnostics() const {
        std::lock_guard lock(mutex);
        auto            d = measurements.diagnostics();
        d[4] += annotation_overflows;
        return d;
    }
    std::string lastError() const {
        std::lock_guard lock(mutex);
        return last_error.empty() ? measurements.lastError() : last_error;
    }
};
} // namespace gr::studio::dataset_waterfall
