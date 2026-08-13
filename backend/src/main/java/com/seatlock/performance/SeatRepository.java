package com.seatlock.performance;

import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SeatRepository extends JpaRepository<Seat, Long> {

    List<Seat> findByVenueIdAndSectionIn(Long venueId, Collection<String> sections);
}
