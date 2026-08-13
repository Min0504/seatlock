package com.seatlock.show;

import com.seatlock.show.dto.ShowDtos.SeatMapResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "shows")
@RestController
@RequestMapping("/shows")
@RequiredArgsConstructor
public class ShowController {

    private final ShowService showService;

    @GetMapping("/{id}/seats")
    @Operation(summary = "회차 좌석맵 조회")
    public SeatMapResponse seatMap(@PathVariable Long id) {
        return showService.getSeatMap(id);
    }
}
